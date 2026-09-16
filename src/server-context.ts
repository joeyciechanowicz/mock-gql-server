import type { GraphQLSchema } from 'graphql';
import type { DocumentCache } from './exec/execute.js';
import type { Session, SessionStore } from './session/store.js';
import { newSession } from './session/store.js';

/**
 * Sessions are created on first use and their TTL is refreshed on every read
 * and every write, so an actively used session never expires underneath a
 * running test.
 */
export class SessionManager {
  #store: SessionStore;
  #ttlMs: number;

  constructor(store: SessionStore, ttlMs: number) {
    this.#store = store;
    this.#ttlMs = ttlMs;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  async ensure(sessionId: string): Promise<Session> {
    const existing = await this.#store.get(sessionId);
    if (existing) {
      existing.expiresAt = Date.now() + this.#ttlMs;
      await this.#store.touch(sessionId, existing.expiresAt);
      return existing;
    }
    const session = newSession(sessionId, this.#ttlMs);
    await this.#store.set(sessionId, session);
    return session;
  }

  async peek(sessionId: string): Promise<Session | undefined> {
    return this.#store.get(sessionId);
  }

  async save(session: Session): Promise<void> {
    session.expiresAt = Date.now() + this.#ttlMs;
    await this.#store.set(session.id, session);
  }

  async destroy(sessionId: string): Promise<boolean> {
    return this.#store.delete(sessionId);
  }

  async close(): Promise<void> {
    await this.#store.close?.();
  }
}

export interface ServerContext {
  schema: GraphQLSchema;
  documentCache: DocumentCache;
  sessions: SessionManager;
  defaultResolvers: Record<string, unknown>;
  verboseByDefault: boolean;
  random: boolean;
}
