import type { PersonalNotesStorage } from './storage.js';
import type { PersonalNote, CompactPersonalNote, NoteFilters } from './types.js';
import type { VectorStore, VectorFilter } from '../vector/vector-store.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import logger from '../logger.js';

export class NotesManager {
  constructor(
    private storage: PersonalNotesStorage,
    private vectorStore?: VectorStore,
    private embeddingProvider?: EmbeddingProvider,
  ) {}

  async write(agentTokenId: string, data: {
    title: string;
    content: string;
    tags: string[];
    priority: string;
    projectId: string | null;
    sessionId: string | null;
  }): Promise<PersonalNote> {
    const note = await this.storage.create({ agentTokenId, ...data });

    if (this.embeddingProvider?.isReady() && this.vectorStore) {
      this.embeddingProvider.embed(note.title + '\n' + note.content, 'document')
        .then(vector => this.vectorStore!.upsert('personal_notes', note.id, vector, {
          note_id: note.id,
          agent_token_id: agentTokenId,
          project_id: note.projectId ?? '',
          session_id: note.sessionId ?? '',
          tags: note.tags,
          status: note.status,
        }))
        .catch(err => logger.error({ err, noteId: note.id }, 'Failed to embed note'));
    }

    return note;
  }

  async read(agentTokenId: string | null, filters: NoteFilters): Promise<(PersonalNote | CompactPersonalNote)[]> {
    if (filters.search) {
      return this.storage.search(agentTokenId, filters.search, filters);
    }
    return this.storage.getAll(agentTokenId, filters);
  }

  async update(noteId: string, agentTokenId: string | null, updates: Record<string, unknown>): Promise<PersonalNote> {
    const note = await this.storage.update(noteId, agentTokenId, updates as any);

    if ((updates.title || updates.content) && this.embeddingProvider?.isReady() && this.vectorStore) {
      this.embeddingProvider.embed(note.title + '\n' + note.content, 'document')
        .then(vector => this.vectorStore!.upsert('personal_notes', note.id, vector, {
          note_id: note.id,
          agent_token_id: note.agentTokenId,
          project_id: note.projectId ?? '',
          session_id: note.sessionId ?? '',
          tags: note.tags,
          status: note.status,
        }))
        .catch(err => logger.error({ err, noteId: note.id }, 'Failed to re-embed note'));
    } else if (this.vectorStore) {
      // Metadata-only change — update payload without re-embedding
      const payload: Record<string, unknown> = {};
      if (updates.status !== undefined) payload.status = note.status;
      if (updates.tags !== undefined) payload.tags = note.tags;
      if (Object.keys(payload).length > 0) {
        this.vectorStore.setPayload('personal_notes', note.id, payload)
          .catch(err => logger.warn({ err, noteId: note.id }, 'Failed to update note Qdrant payload'));
      }
    }

    return note;
  }

  async delete(noteId: string, agentTokenId: string | null, archive: boolean): Promise<boolean> {
    const result = await this.storage.delete(noteId, agentTokenId, archive);

    if (!archive && this.vectorStore) {
      this.vectorStore.delete('personal_notes', [noteId])
        .catch(err => logger.warn({ err, noteId }, 'Failed to delete note vector'));
    } else if (archive && this.vectorStore) {
      this.vectorStore.setPayload('personal_notes', noteId, { status: 'archived' })
        .catch(err => logger.warn({ err, noteId }, 'Failed to update note status in Qdrant'));
    }

    return result;
  }

  async semanticSearch(agentTokenId: string, query: string, options?: {
    projectId?: string;
    sessionId?: string;
    limit?: number;
  }): Promise<Array<PersonalNote & { score: number }>> {
    if (!this.embeddingProvider?.isReady() || !this.vectorStore) {
      return [];
    }

    const queryVector = await this.embeddingProvider.embed(query, 'query');
    const filter: VectorFilter = {
      must: [{ key: 'agent_token_id', match: { value: agentTokenId } }],
    };
    if (options?.projectId) {
      filter.must!.push({ key: 'project_id', match: { value: options.projectId } });
    }
    if (options?.sessionId) {
      filter.must!.push({ key: 'session_id', match: { value: options.sessionId } });
    }

    const results = await this.vectorStore.search('personal_notes', queryVector, filter, options?.limit ?? 10);

    const notes = await Promise.all(
      results.map(async r => {
        const note = await this.storage.getById(r.payload.note_id as string, agentTokenId);
        return note ? { ...note, score: r.score } : null;
      }),
    );

    return notes.filter((n): n is PersonalNote & { score: number } => n !== null);
  }
}
