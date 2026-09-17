import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../server-context.js';
import type { MockInput } from '../mocks/types.js';
import { InvalidMockError, compileMock, serialiseMock } from '../mocks/registry.js';

export function registerApiRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const params = (request: FastifyRequest) => request.params as { sessionId: string; id?: string };

  app.get('/api/:sessionId', async (request, reply) => {
    const { sessionId } = params(request);
    const session = await ctx.sessions.ensure(sessionId);
    return reply.status(200).send({
      sessionId: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ttlMs: ctx.sessions.ttlMs,
      mockCount: session.mocks.length,
    });
  });

  app.delete('/api/:sessionId', async (request, reply) => {
    const { sessionId } = params(request);
    await ctx.sessions.destroy(sessionId);
    return reply.status(204).send();
  });

  app.get('/api/:sessionId/mocks', async (request, reply) => {
    const { sessionId } = params(request);
    const session = await ctx.sessions.ensure(sessionId);
    return reply.status(200).send({ mocks: session.mocks.map(serialiseMock) });
  });

  app.post('/api/:sessionId/mocks', async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = params(request);
    const body = request.body as MockInput | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'A mock descriptor object is required.' });
    }

    const session = await ctx.sessions.ensure(sessionId);
    try {
      session.seq += 1;
      const mock = compileMock(body, ctx.schema, session.seq);
      session.mocks.push(mock);
      await ctx.sessions.save(session);
      return reply.status(201).send(serialiseMock(mock));
    } catch (err) {
      if (err instanceof InvalidMockError) {
        return reply.status(400).send({ error: `${err.field} ${err.message}`, field: err.field });
      }
      throw err;
    }
  });

  app.get('/api/:sessionId/mocks/:id', async (request, reply) => {
    const { sessionId, id } = params(request);
    const session = await ctx.sessions.ensure(sessionId);
    const mock = session.mocks.find((m) => m.id === id);
    if (!mock) return reply.status(404).send({ error: `No mock with id "${id}" in this session.` });
    return reply.status(200).send(serialiseMock(mock));
  });

  app.delete('/api/:sessionId/mocks/:id', async (request, reply) => {
    const { sessionId, id } = params(request);
    const session = await ctx.sessions.ensure(sessionId);
    const index = session.mocks.findIndex((m) => m.id === id);
    if (index === -1) return reply.status(404).send({ error: `No mock with id "${id}" in this session.` });
    session.mocks.splice(index, 1);
    await ctx.sessions.save(session);
    return reply.status(204).send();
  });

  app.delete('/api/:sessionId/mocks', async (request, reply) => {
    const { sessionId } = params(request);
    const session = await ctx.sessions.ensure(sessionId);
    session.mocks = [];
    await ctx.sessions.save(session);
    return reply.status(204).send();
  });
}
