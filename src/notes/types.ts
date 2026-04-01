export interface PersonalNote {
  id: string;
  agentTokenId: string;
  projectId: string | null;
  sessionId: string | null;
  title: string;
  content: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface CompactPersonalNote {
  id: string;
  agentTokenId: string;
  projectId: string | null;
  sessionId: string | null;
  title: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'active' | 'archived';
  updatedAt: string;
}

export interface NoteFilters {
  projectId?: string;
  sessionId?: string;
  search?: string;
  tags?: string[];
  status?: 'active' | 'archived';
  mode?: 'compact' | 'full';
  limit?: number;
  offset?: number;
}
