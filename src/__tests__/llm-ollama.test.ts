import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OllamaLlmClient } from '../llm/ollama.js';

describe('OllamaLlmClient', () => {
  it('uses default model name when not specified', () => {
    const client = new OllamaLlmClient('http://localhost:11434');
    expect(client.modelName).toBe('qwen3.5:4b');
  });

  it('accepts custom model name', () => {
    const client = new OllamaLlmClient('http://localhost:11434', 'qwen2.5:7b');
    expect(client.modelName).toBe('qwen2.5:7b');
  });

  it('is not ready before initialization', () => {
    const client = new OllamaLlmClient();
    expect(client.isReady()).toBe(false);
  });

  it('summarizeSession builds correct prompt with message truncation', async () => {
    const client = new OllamaLlmClient();
    // Mock generate to capture the prompt
    const generateSpy = vi.spyOn(client, 'generate').mockResolvedValue('Test summary');
    // Force ready state
    (client as any).ready = true;

    const messages = [
      { role: 'user', content: 'A'.repeat(1000) },
      { role: 'assistant', content: 'B'.repeat(1000) },
    ];

    const result = await client.summarizeSession(messages);
    expect(result).toBe('Test summary');
    expect(generateSpy).toHaveBeenCalledTimes(1);

    const prompt = generateSpy.mock.calls[0][0];
    expect(prompt).toContain('[user]');
    expect(prompt).toContain('[assistant]');
    // Messages should be truncated to 300 chars each
    expect(prompt).not.toContain('A'.repeat(1000));
    expect(prompt.indexOf('A'.repeat(300))).toBeGreaterThan(-1);
    expect(prompt).toContain('Summarize this development session');
  });
});
