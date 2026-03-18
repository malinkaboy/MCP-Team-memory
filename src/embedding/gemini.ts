import type { EmbeddingProvider, EmbedTaskType } from './provider.js';
import logger from '../logger.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-embedding-001';
const OUTPUT_DIMS = 768;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

/** Map our generic task types to Gemini-specific task types */
const TASK_TYPE_MAP: Record<EmbedTaskType, string> = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
};

interface GeminiEmbedResponse {
  embedding: { values: number[] };
}

interface GeminiBatchEmbedResponse {
  embeddings: Array<{ values: number[] }>;
}

/** Parse Gemini API error from response, with fallback to HTTP status */
async function parseGeminiError(response: Response, context: string): Promise<Error> {
  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as Record<string, any>;
    if (body?.error?.message) {
      detail = `${body.error.code}: ${body.error.message}`;
    }
  } catch { /* use HTTP status fallback */ }
  return new Error(`Gemini ${context} error: ${detail}`);
}

/** Sleep for the given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Embedding provider using Google Gemini API (gemini-embedding-001).
 * Supports asymmetric retrieval via RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY task types.
 * Outputs 768-dimensional vectors. Includes retry with exponential backoff.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = OUTPUT_DIMS;
  readonly modelName = MODEL;
  readonly providerType = 'gemini' as const;
  private apiKey: string;
  private ready = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async initialize(): Promise<void> {
    try {
      await this.embed('test', 'document');
      this.ready = true;
      logger.info({ model: MODEL, dimensions: OUTPUT_DIMS }, 'Gemini embedding provider initialized');
    } catch (err) {
      logger.warn({ err }, 'Gemini embedding provider failed to initialize. Check GEMINI_API_KEY.');
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async embed(text: string, taskType: EmbedTaskType = 'document'): Promise<number[]> {
    const url = `${GEMINI_BASE_URL}/models/${MODEL}:embedContent`;
    const body = JSON.stringify({
      model: `models/${MODEL}`,
      content: { parts: [{ text }] },
      taskType: TASK_TYPE_MAP[taskType],
      outputDimensionality: OUTPUT_DIMS,
    });

    const response = await this.fetchWithRetry(url, body);
    const data = (await response.json()) as GeminiEmbedResponse;
    return data.embedding.values;
  }

  /**
   * Batch embed multiple texts in a single API call.
   * More efficient for backfilling — 1 call per batch instead of N.
   * Gemini batch limit is 100 texts per request.
   */
  async embedBatch(texts: string[], taskType: EmbedTaskType = 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.embed(texts[0], taskType)];

    const url = `${GEMINI_BASE_URL}/models/${MODEL}:batchEmbedContents`;
    const body = JSON.stringify({
      requests: texts.map(text => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text }] },
        taskType: TASK_TYPE_MAP[taskType],
        outputDimensionality: OUTPUT_DIMS,
      })),
    });

    const response = await this.fetchWithRetry(url, body);
    const data = (await response.json()) as GeminiBatchEmbedResponse;
    return data.embeddings.map(e => e.values);
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  /** Fetch with exponential backoff retry on 429 (rate limit) and 5xx errors */
  private async fetchWithRetry(url: string, body: string): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body,
      });

      if (response.ok) return response;

      // Retry on rate limit (429) or server errors (5xx)
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ status: response.status, attempt: attempt + 1, backoffMs: backoff }, 'Gemini API rate limited, retrying');
        await sleep(backoff);
        continue;
      }

      throw await parseGeminiError(response, 'API');
    }

    // Unreachable, but TypeScript needs it
    throw new Error('Gemini API: max retries exceeded');
  }
}
