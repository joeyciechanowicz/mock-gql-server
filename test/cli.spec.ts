import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('npx', ['vite-node', 'src/cli.ts', '--', ...args], {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('the CLI', () => {
  it('prints usage with --help', async () => {
    const { stdout, code } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/--schema/);
    expect(stdout).toMatch(/\/query\/:sessionId/);
  }, 60_000);

  it('exits non-zero when no schema is given', async () => {
    const { code } = await runCli([]);
    expect(code).toBe(1);
  }, 60_000);

  it('refuses to start, non-zero, when a default resolver does not match the schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mgs-'));
    const schema = join(dir, 'schema.graphql');
    const resolvers = join(dir, 'resolvers.mjs');
    await writeFile(schema, 'type User { id: ID! total: Float! }\ntype Query { user: User }');
    await writeFile(resolvers, 'export default { User: { total: "not-a-number" } };');
    const { code, stderr } = await runCli(['--schema', schema, '--resolvers', resolvers, '--port', '0']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/total/);
    expect(stderr).toMatch(/refusing to start/);
  }, 60_000);
});
