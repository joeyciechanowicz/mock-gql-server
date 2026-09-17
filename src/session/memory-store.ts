import type { Session, SessionStore } from './store.js';

/**
 * In-process session store. Expiry is enforced lazily on read, so an idle
 * server does no work; a periodic sweep bounds memory when sessions are
 * created and abandoned.
 */
export class MemorySessionStore implements SessionStore {
  #sessions = new Map<string, Session>();
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(opts: { sweepIntervalMs?: number } = {}) {
    const interval = opts.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.#sweepTimer = setInterval(() => this.sweep(), interval);
      // Never hold the process open just to sweep.
      this.#sweepTimer.unref?.();
    }
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.#sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  async set(sessionId: string, session: Session): Promise<void> {
    this.#sessions.set(sessionId, session);
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.#sessions.delete(sessionId);
  }

  async touch(sessionId: string, expiresAt: number): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session) session.expiresAt = expiresAt;
  }

  sweep(now = Date.now()): void {
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }

  async close(): Promise<void> {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sessions.clear();
  }
}
