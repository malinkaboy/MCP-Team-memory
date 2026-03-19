/**
 * Task type hint for embedding providers that support asymmetric retrieval.
 * - 'document': text being indexed (default)
 * - 'query': search query
 */
export type EmbedTaskType = 'document' | 'query';

/**
 * Abstract interface for embedding providers.
 * Implementations: LocalEmbeddingProvider (ONNX), GeminiEmbeddingProvider (API).
 */
export interface EmbeddingProvider {
  /** Generate embedding vector for the given text */
  embed(text: string, taskType?: EmbedTaskType): Promise<number[]>;

  /**
   * Batch embed multiple texts. Gemini provider uses a true batch API call (up to 100 texts).
   * Local provider falls back to sequential embed() calls.
   */
  embedBatch?(texts: string[], taskType?: EmbedTaskType): Promise<number[][]>;

  /** Whether the provider is initialized and ready to generate embeddings */
  isReady(): boolean;

  /** Release native resources (ONNX session, API connections, etc.) */
  close?(): Promise<void>;

  /** Dimensionality of the output vectors */
  readonly dimensions: number;

  /** Human-readable model name for UI display */
  readonly modelName: string;

  /** Provider type identifier for programmatic use */
  readonly providerType: 'gemini' | 'local';
}
