import logger from '../logger.js';

/**
 * Ollama LLM client for text generation (summarization, etc.)
 * Uses /api/generate endpoint — separate from embedding (/api/embed).
 */

const DEFAULT_MODEL = 'qwen3.5:4b';
const MAX_INPUT_CHARS = 50_000; // ~12K tokens, safe for 256K context models

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
        signal: AbortSignal.timeout(300_000), // 5 min — gemma4:26b cold start loads ~16GB into RAM
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

    const truncated = prompt.length > MAX_INPUT_CHARS ? prompt.slice(0, MAX_INPUT_CHARS) + '\n...[truncated]' : prompt;

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        prompt: truncated,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.3,
          num_predict: options?.maxTokens ?? 500,
        },
      }),
      signal: AbortSignal.timeout(300_000), // 5 min — summarization can be slow on CPU
    });

    if (!res.ok) throw new Error(`Ollama generate error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { response: string };
    return data.response.trim();
  }

  async summarizeSession(messages: Array<{ role: string; content: string }>): Promise<string> {
    const conversation = messages
      .map(m => `[${m.role}]: ${m.content.slice(0, 500)}`)
      .join('\n\n');

    const prompt = `Summarize this development session in 3-5 sentences. Focus on: what was built/changed, key decisions made, and the outcome. Write in the same language as the conversation.

Session transcript:
${conversation}

Summary:`;

    return this.generate(prompt, { temperature: 0.2, maxTokens: 300 });
  }

  async chat(messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>, options?: LlmGenerateOptions): Promise<string> {
    if (!this.ready) throw new Error('LLM client not initialized');

    // Truncate each message to prevent context overflow
    const truncated = messages.map(m => ({
      role: m.role,
      content: m.content.length > 10_000 ? m.content.slice(0, 10_000) + '...[truncated]' : m.content,
    }));

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        messages: truncated,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.7,
          num_predict: options?.maxTokens ?? 2048,
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
