import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createMockServer } from './server.js';
import { MockServerStartupError } from './schema/load.js';
import type { DefaultResolvers } from './schema/validate-resolvers.js';

interface Args {
  schema?: string;
  resolvers?: string;
  port: number;
  host: string;
  ttl: number;
  debug: 'summary' | 'verbose';
  randomness: 'seeded' | 'random';
  help: boolean;
}

const USAGE = `
mock-gql-server — a session-scoped GraphQL mock server

Usage:
  mock-gql-server --schema <file> [options]

Options:
  --schema <file>       Path to a .graphql SDL file                 (required)
  --resolvers <file>    Module exporting default resolvers by type name
  --port <n>            Port to listen on                           (default 4000)
  --host <host>         Host to bind                                (default 127.0.0.1)
  --ttl <ms>            Session lifetime, refreshed on use          (default 900000)
  --debug <mode>        summary | verbose                           (default summary)
  --randomness <mode>   seeded | random                             (default seeded)
  -h, --help            Show this message

Endpoints:
  POST|GET /query/:sessionId   Execute an operation for a session
  /api/:sessionId              Set, list and delete that session's mocks
`.trim();

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 4000, host: '127.0.0.1', ttl: 900_000, debug: 'summary', randomness: 'seeded', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    switch (arg) {
      case '--schema': args.schema = next(); break;
      case '--resolvers': args.resolvers = next(); break;
      case '--port': args.port = Number(next()); break;
      case '--host': args.host = String(next()); break;
      case '--ttl': args.ttl = Number(next()); break;
      case '--debug': args.debug = next() === 'verbose' ? 'verbose' : 'summary'; break;
      case '--randomness': args.randomness = next() === 'random' ? 'random' : 'seeded'; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option "${arg}"`);
    }
  }
  return args;
}

/** A resolvers module may use a default export or name it `defaultResolvers`. */
async function loadResolvers(file: string): Promise<DefaultResolvers> {
  const url = pathToFileURL(resolve(file)).href;
  const module = (await import(url)) as Record<string, unknown>;
  const resolvers = module['default'] ?? module['defaultResolvers'] ?? module;
  if (!resolvers || typeof resolvers !== 'object') {
    throw new Error(`${file} does not export an object of default resolvers`);
  }
  return resolvers as DefaultResolvers;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (args.help || !args.schema) {
    console.log(USAGE);
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const schema = await readFile(resolve(args.schema), 'utf8');
  const defaultResolvers = args.resolvers ? await loadResolvers(args.resolvers) : {};

  const server = await createMockServer({
    schema,
    defaultResolvers,
    ttlMs: args.ttl,
    debug: args.debug,
    randomness: args.randomness,
  });

  const url = await server.listen({ port: args.port, host: args.host });
  console.log(`mock-gql-server listening on ${url}`);
  console.log(`  queries  ${url}/query/:sessionId`);
  console.log(`  mock api ${url}/api/:sessionId`);

  const shutdown = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
