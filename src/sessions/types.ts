export interface Session {
  id: string;
  agentTokenId: string;
  projectId: string | null;
  externalId: string | null;
  name: string | null;
  summary: string;
  workingDirectory: string | null;
  gitBranch: string | null;
  messageCount: number;
  embeddingStatus: 'pending' | 'processing' | 'complete' | 'failed';
  startedAt: string | null;
  endedAt: string | null;
  importedAt: string;
  tags: string[];
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageIndex: number;
  hasToolUse: boolean;
  toolNames: string[];
  timestamp: string | null;
}

export interface SessionChunk {
  text: string;
  messageId: string;
  chunkIndex: number;
  totalChunks: number;
}

export interface SessionFilters {
  projectId?: string;
  tags?: string[];
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
}
