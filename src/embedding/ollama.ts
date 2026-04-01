import type { EmbeddingProvider, EmbedTaskType } from './provider.js';
import logger from '../logger.js';

/**
 * Ollama embedding provider using nomic-embed-text model.
 * 768 dimensions, excellent multilingual (Russian/English) support.
 * Requires Ollama running locally: curl -fsSL https://ollama.com/install.sh | sh
 * Model pulled automatically on first use.
 */
const DEFAULT_MODEL = 'nomic-embed-text';

// Ollama default context for nomic-embed-text is ~2048 tokens.
// Cyrillic chars tokenize as ~2 tokens each. Conservative limit:
// ~2000 tokens / ~2 tokens/char for Cyrillic = ~1000 Cyrillic chars.
// Mixed text: use 4000 chars as a safe middle ground.
const MAX_EMBED_CHARS = 4000;

function truncateForEmbed(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  dimensions = 768;  // default, auto-detected from test embed during initialize()
  readonly modelName: string;
  readonly providerType = 'ollama' as const;
  private ready = false;
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:11434', model?: string) {
    this.baseUrl = baseUrl;
    this.modelName = model || DEFAULT_MODEL;
  }

  isReady(): boolean { return this.ready; }

  async initialize(): Promise<void> {
    try {
      const healthRes = await fetch(`${this.baseUrl}/api/tags`);
      if (!healthRes.ok) throw new Error(`Ollama not reachable: ${healthRes.status}`);
      const tags = await healthRes.json() as { models?: { name: string }[] };
      const hasModel = tags.models?.some(m => m.name.startsWith(this.modelName));
      if (!hasModel) {
        logger.info(`Pulling ${this.modelName} model...`);
        const pullRes = await fetch(`${this.baseUrl}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.modelName, stream: false }),
        });
        if (!pullRes.ok) throw new Error(`Failed to pull model: ${await pullRes.text()}`);
        logger.info(`Model ${this.modelName} pulled successfully`);
      }
      // Test embed call (direct fetch, not through this.embed which guards on ready)
      const testRes = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelName, truncate: true, input: 'search_query: test' }),
      });
      if (!testRes.ok) throw new Error(`Test embed failed: ${testRes.status}`);
      const testData = await testRes.json() as { embeddings: number[][] };
      // Auto-detect dimensions from the model's actual output
      this.dimensions = testData.embeddings[0].length;
      this.ready = true;
      logger.info({ model: this.modelName, dimensions: this.dimensions, baseUrl: this.baseUrl },
        'Ollama embedding provider initialized');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize Ollama embedding provider. Vector search disabled.');
      this.ready = false;
    }
  }

  async embed(text: string, taskType: EmbedTaskType = 'document'): Promise<number[]> {
    if (!this.ready) throw new Error('Embedding provider not initialized');
    const prefix = taskType === 'query' ? 'search_query: ' : 'search_document: ';
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, truncate: true, input: prefix + truncateForEmbed(text) }),
    });
    if (!res.ok) throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings[0];
  }

  async embedBatch(texts: string[], taskType: EmbedTaskType = 'document'): Promise<number[][]> {
    if (!this.ready) throw new Error('Embedding provider not initialized');
    if (texts.length === 0) return [];
    const prefix = taskType === 'query' ? 'search_query: ' : 'search_document: ';
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, truncate: true, input: texts.map(t => prefix + truncateForEmbed(t)) }),
    });
    if (!res.ok) throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings;
  }

  async close(): Promise<void> { this.ready = false; }
}
