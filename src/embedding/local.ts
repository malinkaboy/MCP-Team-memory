import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { EmbeddingProvider } from './provider.js';
import logger from '../logger.js';

/**
 * Local embedding provider using onnxruntime-node with all-MiniLM-L6-v2 model.
 * Model is downloaded on first use to the specified directory.
 * Lazy initialization — if model isn't available, isReady() returns false.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'all-MiniLM-L6-v2';
  readonly providerType = 'local' as const;
  private session: any = null;
  private tokenizer: any = null;
  private ort: any = null;
  private ready = false;
  private initializing = false;
  private modelDir: string;

  constructor(modelDir: string = 'data/models') {
    this.modelDir = modelDir;
  }

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (this.ready || this.initializing) return;
    this.initializing = true;

    try {
      // Ensure model directory exists
      if (!existsSync(this.modelDir)) {
        mkdirSync(this.modelDir, { recursive: true });
      }

      const modelPath = path.join(this.modelDir, 'all-MiniLM-L6-v2');

      if (!existsSync(path.join(modelPath, 'onnx', 'model.onnx'))) {
        logger.info({ modelPath }, 'ONNX model not found. Download it manually or wait for auto-download.');
        logger.info('Download from: https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx');
        this.initializing = false;
        return;
      }

      // Dynamic imports to avoid requiring onnxruntime-node when not used
      this.ort = await import('onnxruntime-node' as string);
      const { AutoTokenizer } = await import('@xenova/transformers' as string);

      this.session = await this.ort.InferenceSession.create(
        path.join(modelPath, 'onnx', 'model.onnx')
      );
      this.tokenizer = await AutoTokenizer.from_pretrained(modelPath);

      this.ready = true;
      logger.info('Local embedding provider initialized (all-MiniLM-L6-v2)');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize local embedding provider. Vector search disabled.');
      this.ready = false;
    } finally {
      this.initializing = false;
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.ready) {
      throw new Error('Embedding provider not initialized');
    }

    const encoded = await this.tokenizer(text, {
      padding: true,
      truncation: true,
      max_length: 256,
    });

    const inputIds = new this.ort.Tensor(
      'int64',
      BigInt64Array.from(encoded.input_ids.data.map((v: number) => BigInt(v))),
      encoded.input_ids.dims
    );

    const attentionMask = new this.ort.Tensor(
      'int64',
      BigInt64Array.from(encoded.attention_mask.data.map((v: number) => BigInt(v))),
      encoded.attention_mask.dims
    );

    const output = await this.session.run({
      input_ids: inputIds,
      attention_mask: attentionMask,
    });

    // Mean pooling over token embeddings
    const embeddings = output.last_hidden_state || output.token_embeddings;
    const data = Array.from(embeddings.data as Float32Array);
    const seqLen = embeddings.dims[1];
    const hiddenSize = embeddings.dims[2];

    const result = new Array(hiddenSize).fill(0);
    for (let i = 0; i < seqLen; i++) {
      for (let j = 0; j < hiddenSize; j++) {
        result[j] += data[i * hiddenSize + j];
      }
    }
    for (let j = 0; j < hiddenSize; j++) {
      result[j] /= seqLen;
    }

    // L2 normalize (guard against zero-norm degenerate input)
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return result;
    return result.map(v => v / norm);
  }

  async close(): Promise<void> {
    if (this.session) {
      try {
        await this.session.release?.();
      } catch { /* best effort */ }
      this.session = null;
    }
    this.tokenizer = null;
    this.ort = null;
    this.ready = false;
  }
}
