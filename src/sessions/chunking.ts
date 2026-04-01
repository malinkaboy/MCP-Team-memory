import type { SessionChunk } from './types.js';

const MAX_CHUNK_TOKENS = 2000;
const OVERLAP_TOKENS = 100;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function charsForTokens(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

export function chunkMessage(content: string, messageId: string): SessionChunk[] {
  const tokens = estimateTokens(content);

  if (tokens <= MAX_CHUNK_TOKENS) {
    return [{
      text: content,
      messageId,
      chunkIndex: 0,
      totalChunks: 1,
    }];
  }

  const chunks: SessionChunk[] = [];
  const maxChars = charsForTokens(MAX_CHUNK_TOKENS);
  const stepChars = charsForTokens(MAX_CHUNK_TOKENS - OVERLAP_TOKENS);
  let offset = 0;

  while (offset < content.length) {
    const end = Math.min(offset + maxChars, content.length);
    chunks.push({
      text: content.slice(offset, end),
      messageId,
      chunkIndex: chunks.length,
      totalChunks: -1,
    });
    offset += stepChars;
    if (end === content.length) break;
  }

  chunks.forEach(c => c.totalChunks = chunks.length);
  return chunks;
}
