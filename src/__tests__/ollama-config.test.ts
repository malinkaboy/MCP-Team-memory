import { describe, it, expect } from 'vitest';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';

describe('OllamaEmbeddingProvider config', () => {
  it('uses default model name when not specified', () => {
    const provider = new OllamaEmbeddingProvider('http://localhost:11434');
    expect(provider.modelName).toBe('nomic-embed-text-v2-moe');
  });

  it('accepts custom model name', () => {
    const provider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text');
    expect(provider.modelName).toBe('nomic-embed-text');
  });

  it('reports providerType as ollama', () => {
    const provider = new OllamaEmbeddingProvider('http://localhost:11434');
    expect(provider.providerType).toBe('ollama');
  });
});
