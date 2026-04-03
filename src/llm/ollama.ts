import logger from '../logger.js';

/**
 * Ollama LLM client for text generation (summarization, chat).
 * Uses /api/generate and /api/chat endpoints — separate from embedding (/api/embed).
 *
 * Performance baseline (qwen3.5:4b on 4-core Xeon CPU, no GPU):
 *   ~3.6 tok/s → 50 tokens in ~14s, 200 tokens in ~55s, 500 tokens in ~2.5min
 */

const DEFAULT_MODEL = 'qwen3.5:4b';

// Input truncation: 262K context ≈ 500K chars, but we stay conservative
// to keep inference fast. Summarization doesn't need the full session.
const MAX_GENERATE_INPUT_CHARS = 30_000;  // ~7K tokens — keeps prompt processing fast
const MAX_CHAT_MESSAGE_CHARS = 3_000;     // per-message truncation for chat history

export interface LlmGenerateOptions {
  temperature?: number;
  maxTokens?: number;
}

export class OllamaLlmClient {
  readonly modelName: string;
  private baseUrl: string;
  private ready = false;

  constructor(baseUrl: string = 'http://localhost:11434', model?: string) {
    this.baseUrl = baseUrl;
    this.modelName = model || DEFAULT_MODEL;
  }

  isReady(): boolean { return this.ready; }

  async initialize(): Promise<void> {
    try {
      const healthRes = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!healthRes.ok) throw new Error(`Ollama not reachable: ${healthRes.status}`);
      const tags = await healthRes.json() as { models?: { name: string }[] };
      const hasModel = tags.models?.some(m => m.name.startsWith(this.modelName));
      if (!hasModel) {
        logger.info(`Pulling ${this.modelName} model...`);
        const pullRes = await fetch(`${this.baseUrl}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.modelName, stream: false }),
          signal: AbortSignal.timeout(600_000), // 10 min — large models take time to pull
        });
        if (!pullRes.ok) throw new Error(`Failed to pull model: ${await pullRes.text()}`);
        logger.info(`Model ${this.modelName} pulled successfully`);
      }
      // Quick test generation
      const testRes = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelName, prompt: 'Hi', stream: false, options: { num_predict: 1 } }),
        signal: AbortSignal.timeout(300_000), // 5 min — cold start loads model into RAM
      });
      if (!testRes.ok) throw new Error(`Test generate failed: ${testRes.status}`);
      this.ready = true;
      logger.info({ model: this.modelName, baseUrl: this.baseUrl }, 'Ollama LLM client initialized');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize Ollama LLM client. Summarization disabled.');
      this.ready = false;
    }
  }

  async generate(prompt: string, options?: LlmGenerateOptions): Promise<string> {
    if (!this.ready) throw new Error('LLM client not initialized');

    const truncated = prompt.length > MAX_GENERATE_INPUT_CHARS
      ? prompt.slice(0, MAX_GENERATE_INPUT_CHARS) + '\n...[truncated]'
      : prompt;

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        prompt: truncated,
        stream: false,
        think: false,
        options: {
          temperature: options?.temperature ?? 0.3,
          num_predict: options?.maxTokens ?? 300,
        },
      }),
      signal: AbortSignal.timeout(300_000), // 5 min
    });

    if (!res.ok) throw new Error(`Ollama generate error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { response: string };
    return data.response.trim();
  }

  /**
   * Summarize a session. For large sessions (100+ messages), samples
   * first/last messages + every Nth to stay within input limits.
   */
  async summarizeSession(messages: Array<{ role: string; content: string }>): Promise<string> {
    let sampled: Array<{ role: string; content: string }>;

    if (messages.length <= 40) {
      sampled = messages;
    } else {
      // Sample: first 10 + every Nth from middle + last 10
      const first = messages.slice(0, 10);
      const last = messages.slice(-10);
      const middle = messages.slice(10, -10);
      const step = Math.ceil(middle.length / 20);
      const middleSampled = middle.filter((_, i) => i % step === 0);
      sampled = [...first, ...middleSampled, ...last];
    }

    const conversation = sampled
      .map(m => `[${m.role}]: ${m.content.slice(0, 300)}`)
      .join('\n');

    const prompt = `Summarize this development session in 3-5 sentences. Focus on: what was built/changed, key decisions made, and the outcome. Write in the same language as the conversation.

Session transcript (${messages.length} messages total):
${conversation}

Summary:`;

    return this.generate(prompt, { temperature: 0.2, maxTokens: 200 });
  }

  async chat(messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>, options?: LlmGenerateOptions): Promise<string> {
    if (!this.ready) throw new Error('LLM client not initialized');

    const truncated = messages.map(m => ({
      role: m.role,
      content: m.content.length > MAX_CHAT_MESSAGE_CHARS
        ? m.content.slice(0, MAX_CHAT_MESSAGE_CHARS) + '...[truncated]'
        : m.content,
    }));

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        messages: truncated,
        stream: false,
        think: false,
        options: {
          temperature: options?.temperature ?? 0.7,
          num_predict: options?.maxTokens ?? 500, // ~2.5 min at 3.6 tok/s
        },
      }),
      signal: AbortSignal.timeout(300_000), // 5 min
    });

    if (!res.ok) throw new Error(`Ollama chat error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { message: { content: string } };
    return data.message.content.trim();
  }

  async close(): Promise<void> { this.ready = false; }
}
