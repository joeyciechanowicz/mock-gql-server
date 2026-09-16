import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../server-context.js';
import { executeRequest } from '../exec/execute.js';

interface GraphQLRequestBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function isVerbose(request: FastifyRequest, fallback: boolean): boolean {
  const header = request.headers['x-mock-debug'];
  if (typeof header === 'string') return header !== '0' && header.toLowerCase() !== 'false';
  const q = (request.query as Record<string, unknown> | undefined)?.['debug'];
  if (typeof q === 'string') return q !== '0' && q.toLowerCase() !== 'false';
  return fallback;
}

export function registerQueryRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = request.query as Record<string, unknown> | undefined;
    const body = (request.body ?? {}) as GraphQLRequestBody;

    const queryText = body.query ?? (typeof query?.['query'] === 'string' ? (query['query'] as string) : undefined);
    if (typeof queryText !== 'string' || queryText.trim() === '') {
      return reply.status(400).send({ errors: [{ message: 'Must provide a query string.' }] });
    }

    let variables: Record<string, unknown> = body.variables ?? {};
    if (typeof query?.['variables'] === 'string') {
      try {
        variables = JSON.parse(query['variables'] as string) as Record<string, unknown>;
      } catch {
        return reply.status(400).send({ errors: [{ message: 'Variables must be valid JSON.' }] });
      }
    }
    const operationName =
      body.operationName ?? (typeof query?.['operationName'] === 'string' ? (query['operationName'] as string) : undefined);

    // Reading a session refreshes its TTL, same as writing to it.
    const session = await ctx.sessions.ensure(sessionId);

    const { result, consumed } = await executeRequest({
      schema: ctx.schema,
      documentCache: ctx.documentCache,
      sessionId,
      mocks: session.mocks,
      defaultResolvers: ctx.defaultResolvers,
      query: queryText,
      variables,
      operationName,
      verbose: isVerbose(request, ctx.verboseByDefault),
      random: ctx.random,
    });

    if (consumed.length > 0) {
      for (const mock of consumed) {
        if (mock.remaining !== null) mock.remaining -= 1;
      }
      await ctx.sessions.save(session);
    }

    const payload: Record<string, unknown> = {};
    if (result.data !== undefined) payload['data'] = result.data;
    if (result.errors) {
      payload['errors'] = result.errors.map((e) => ({
        message: e.message,
        ...(e.path ? { path: e.path } : {}),
        ...(e.extensions && Object.keys(e.extensions).length > 0 ? { extensions: e.extensions } : {}),
      }));
    }
    if (result.extensions) payload['extensions'] = result.extensions;

    return reply.status(200).send(payload);
  };

  app.post('/query/:sessionId', handler);
  app.get('/query/:sessionId', handler);
}
