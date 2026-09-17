import { describe, it, expect } from 'vitest';
import { makeServer } from './helpers.js';

/**
 * A default resolver that cannot produce schema-valid data must never reach a
 * caller, so the server refuses to start.
 */
describe('startup validation of default resolvers', () => {
  const failsWith = async (defaultResolvers: Record<string, unknown>): Promise<string> => {
    try {
      const server = await makeServer({ defaultResolvers });
      await server.close();
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  };

  it('starts cleanly when every resolver conforms', async () => {
    const server = await makeServer({
      defaultResolvers: { User: { name: 'Ada', status: 'ACTIVE' }, Order: { total: 1.5 } },
    });
    expect(server).toBeDefined();
    await server.close();
  });

  it('fails when a string is supplied for a Float field', async () => {
    const message = await failsWith({ Order: { total: 'not-a-number' } });
    expect(message).toMatch(/Order/);
    expect(message).toMatch(/total/);
    expect(message).toMatch(/Float/);
  });

  it('fails when an object is supplied for a String field', async () => {
    const message = await failsWith({ User: { name: { nested: true } } });
    expect(message).toMatch(/name/);
    expect(message).toMatch(/String/);
  });

  it('fails on a value that is not a member of the enum', async () => {
    const message = await failsWith({ User: { status: 'NOPE' } });
    expect(message).toMatch(/status/);
    expect(message).toMatch(/Status/);
  });

  it('fails when null is supplied for a non-null field', async () => {
    const message = await failsWith({ User: { name: null } });
    expect(message).toMatch(/name/);
    expect(message).toMatch(/non-nullable|Cannot return null/i);
  });

  it('fails when a scalar is supplied where a list is expected', async () => {
    const message = await failsWith({ User: { orders: 'not-a-list' } });
    expect(message).toMatch(/orders/);
  });

  it('fails on a field that does not exist on the type', async () => {
    const message = await failsWith({ User: { notAField: 'x' } });
    expect(message).toMatch(/notAField/);
    expect(message).toMatch(/no such field/);
  });

  it('fails on a type that does not exist in the schema', async () => {
    const message = await failsWith({ NotAType: { x: 1 } });
    expect(message).toMatch(/NotAType/);
    expect(message).toMatch(/no such type/);
  });

  it('fails when the resolver is not an object', async () => {
    expect(await failsWith({ User: 'a string' })).toMatch(/expected an object/);
  });

  it('fails when the resolver throws', async () => {
    const message = await failsWith({ User: () => { throw new Error('boom'); } });
    expect(message).toMatch(/boom/);
  });

  it('reports every problem together, not just the first', async () => {
    const message = await failsWith({
      User: { name: { bad: true }, status: 'NOPE' },
      Order: { total: 'nope' },
    });
    expect(message).toMatch(/name/);
    expect(message).toMatch(/status/);
    expect(message).toMatch(/total/);
    expect(message).toMatch(/3 default resolver problem/);
  });

  it('accepts a partial resolver that omits non-null fields', async () => {
    // Omitting is fine; what is supplied must be correct.
    const server = await makeServer({ defaultResolvers: { User: { name: 'Ada' } } });
    await server.close();
  });

  it('validates nested objects inside the resolver value', async () => {
    const message = await failsWith({ User: { profile: { avatarUrl: 42, bio: {} } } });
    expect(message).toMatch(/bio/);
  });

  it('rejects an invalid schema before it looks at resolvers', async () => {
    await expect(makeServer({ schema: 'type Query { user: NotDefined }' })).rejects.toThrow();
  });
});
