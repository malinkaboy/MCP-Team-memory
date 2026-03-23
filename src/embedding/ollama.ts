import type { EmbeddingProvider, EmbedTaskType } from './provider.js';
import logger from '../logger.js';

/**
 * Ollama embedding provider using nomic-embed-text model.
 * 768 dimensions, excellent multilingual (Russian/English) support.
 * Requires Ollama running locally: curl -fsSL https://ollama.com/install.sh | sh
 * Model pulled automatically on first use.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;
  readonly modelName = 'nomic-embed-text';
  readonly providerType = 'ollama' as const;
  private ready = false;
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
  }

  isReady(): boolean { return this.ready; }

  async initialize(): Promise<void> {
    try {
      const healthRes = await fetch(`${this.baseUrl}/api/tags`);
      if (!healthRes.ok) throw new Error(`Ollama not reachable: ${healthRes.status}`);
      const tags = await healthRes.json() as { models?: { name: string }[] };
      const hasModel = tags.models?.some(m => m.name.startsWith('nomic-embed-text'));
      if (!hasModel) {
        logger.info('Pulling nomic-embed-text model (274 MB)...');
        const pullRes = await fetch(`${this.baseUrl}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'nomic-embed-text', stream: false }),
        });
        if (!pullRes.ok) throw new Error(`Failed to pull model: ${await pullRes.text()}`);
        logger.info('Model nomic-embed-text pulled successfully');
      }
      // Test embed call (direct fetch, not through this.embed which guards on ready)
      const testRes = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', truncate: true, input: 'search_query: test' }),
      });
      if (!testRes.ok) throw new Error(`Test embed failed: ${testRes.status}`);
      const testData = await testRes.json() as { embeddings: number[][] };
      if (testData.embeddings[0].length !== this.dimensions) {
        throw new Error(`Expected ${this.dimensions} dimensions, got ${testData.embeddings[0].length}`);
      }
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
      body: JSON.stringify({ model: 'nomic-embed-text', truncate: true, input: prefix + text }),
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
      body: JSON.stringify({ model: 'nomic-embed-text', truncate: true, input: texts.map(t => prefix + t) }),
    });
    if (!res.ok) throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings;
  }

  async close(): Promise<void> { this.ready = false; }
}
