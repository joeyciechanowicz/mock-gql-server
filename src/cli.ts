#!/usr/bin/env node
import { main } from './cli-main.js';
import { MockServerStartupError } from './schema/load.js';

main().catch((err: unknown) => {
  if (err instanceof MockServerStartupError) {
    console.error(`\n${err.message}\n`);
  } else {
    console.error(`\nmock-gql-server failed to start: ${(err as Error).message}\n`);
  }
  process.exit(1);
});
