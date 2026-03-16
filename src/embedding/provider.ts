/**
 * Abstract interface for embedding providers.
 * Local ONNX implementation is the default. OpenAI/Voyage can be added later.
 */
export interface EmbeddingProvider {
  /** Generate embedding vector for the given text */
  embed(text: string): Promise<number[]>;

  /** Whether the provider is initialized and ready to generate embeddings */
  isReady(): boolean;

  /** Dimensionality of the output vectors */
  readonly dimensions: number;
}
