import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { EmbeddingProvider, EmbedTaskType } from './provider.js';
import logger from '../logger.js';

/**
 * Local embedding provider using onnxruntime-node with nomic-embed-text-v1.5 model.
 * 768 dimensions, excellent Russian language support, fast on CPU.
 * Model must be downloaded manually on first use.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;
  readonly modelName = 'nomic-embed-text-v1.5';
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
      if (!existsSync(this.modelDir)) {
        mkdirSync(this.modelDir, { recursive: true });
      }

      const modelPath = path.join(this.modelDir, 'nomic-embed-text-v1.5');

      if (!existsSync(path.join(modelPath, 'onnx', 'model.onnx'))) {
        logger.info({ modelPath }, 'ONNX model not found. Download nomic-embed-text-v1.5:');
        logger.info('Download from: https://huggingface.co/Xenova/nomic-embed-text-v1.5/tree/main');
        logger.info('Required files in ' + modelPath + ': tokenizer.json, tokenizer_config.json, special_tokens_map.json');
        logger.info('Required files in ' + path.join(modelPath, 'onnx/') + ': model.onnx');
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
      logger.info({ model: this.modelName, dimensions: this.dimensions }, 'Local embedding provider initialized');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize local embedding provider. Vector search disabled.');
      this.ready = false;
    } finally {
      this.initializing = false;
    }
  }

  async embed(text: string, taskType: EmbedTaskType = 'document'): Promise<number[]> {
    if (!this.ready) {
      throw new Error('Embedding provider not initialized');
    }

    // nomic-embed-text uses task prefixes for asymmetric retrieval
    const prefix = taskType === 'query' ? 'search_query: ' : 'search_document: ';
    const prefixedText = prefix + text;

    const encoded = await this.tokenizer(prefixedText, {
      padding: true,
      truncation: true,
      max_length: 512, // safe for most ONNX exports; nomic supports up to 8192 natively
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
    // Note: single-sequence tokenization produces no padding, so seqLen == actual tokens
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

    // L2 normalize
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return result;
    return result.map(v => v / norm);
  }

  async embedBatch(texts: string[], taskType: EmbedTaskType = 'document'): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text, taskType));
    }
    return results;
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
