import { describe, it, expect } from 'vitest';
import { chunkMessage, estimateTokens } from '../sessions/chunking.js';

describe('estimateTokens', () => {
  it('estimates roughly 4 chars per token', () => {
    const tokens = estimateTokens('Hello world, this is a test.');
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(15);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('chunkMessage', () => {
  it('returns single chunk for short messages', () => {
    const chunks = chunkMessage('Short message', 'msg-1');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].totalChunks).toBe(1);
    expect(chunks[0].messageId).toBe('msg-1');
    expect(chunks[0].text).toBe('Short message');
  });

  it('splits long messages into multiple chunks', () => {
    // ~3000 tokens = ~12000 chars
    const longMessage = 'word '.repeat(3000);
    const chunks = chunkMessage(longMessage, 'msg-2');

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[chunks.length - 1].chunkIndex).toBe(chunks.length - 1);
    chunks.forEach(c => {
      expect(c.totalChunks).toBe(chunks.length);
      expect(c.messageId).toBe('msg-2');
    });
  });

  it('includes overlap between chunks', () => {
    const longMessage = 'word '.repeat(3000);
    const chunks = chunkMessage(longMessage, 'msg-3');

    if (chunks.length >= 2) {
      // Due to overlap, joined text will be longer than original
      const totalChunkLength = chunks.reduce((sum, c) => sum + c.text.length, 0);
      expect(totalChunkLength).toBeGreaterThan(longMessage.length);
    }
  });

  it('preserves all content across chunks', () => {
    const longMessage = 'The quick brown fox jumps over the lazy dog. '.repeat(200);
    const chunks = chunkMessage(longMessage, 'msg-4');

    const words = ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog'];
    words.forEach(word => {
      const found = chunks.some(c => c.text.includes(word));
      expect(found).toBe(true);
    });
  });

  it('handles exactly at threshold', () => {
    // 2000 tokens * 4 chars = 8000 chars
    const exactMessage = 'a'.repeat(8000);
    const chunks = chunkMessage(exactMessage, 'msg-5');
    expect(chunks).toHaveLength(1);
  });

  it('handles just over threshold', () => {
    const overMessage = 'a'.repeat(8001);
    const chunks = chunkMessage(overMessage, 'msg-6');
    expect(chunks.length).toBeGreaterThan(1);
  });
});
