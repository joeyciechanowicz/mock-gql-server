import type { Mock } from '../mocks/types.js';

export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
  mocks: Mock[];
  /** Monotonic counter backing the newest-wins tie-break. */
  seq: number;
}

/**
 * Sessions live behind this interface so the in-memory store shipped here can
 * be swapped for a shared one (Redis) without touching the rest of the server.
 */
export interface SessionStore {
  get(sessionId: string): Promise<Session | undefined>;
  set(sessionId: string, session: Session): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
  /** Refresh the TTL without reading the whole session. */
  touch(sessionId: string, expiresAt: number): Promise<void>;
  close?(): Promise<void>;
}

export function newSession(id: string, ttlMs: number, now = Date.now()): Session {
  return { id, createdAt: now, expiresAt: now + ttlMs, mocks: [], seq: 0 };
}
