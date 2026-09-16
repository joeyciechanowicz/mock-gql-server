import { Bench } from 'tinybench';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCases } from './suites.js';

const BASELINE = resolve(import.meta.dirname, 'baseline.json');

/**
 * How much slower than the baseline a case may get before the build fails.
 *
 * Deliberately generous. Measured back-to-back on one machine these cases
 * swing up to ~16%, and a CI runner adds more on top (the async cases read
 * 12-49% slower there while the pure-CPU ones land within 2%). A tighter gate
 * fires on noise, and a gate that cries wolf gets ignored.
 *
 * It is set to catch the regressions that actually matter, which are large:
 * losing the document cache is +1000%, not +15%. The invariants below are the
 * real protection, because ratios measured in the same run are portable across
 * machines in a way wall-clock milliseconds are not.
 */
const THRESHOLD = 0.4;

/**
 * Structural guarantees that must hold on any machine. Each compares two cases
 * from the same run, so hardware speed cancels out.
 */
const INVARIANTS: { name: string; slow: string; fast: string; minRatio?: number; maxRatio?: number }[] = [
  {
    name: 'the document cache still works',
    slow: 'cache: parse+validate (uncached)',
    fast: 'cache: parse+validate (cached)',
    minRatio: 100,
  },
  {
    name: 'matching does not blow up with mock count',
    slow: 'matching: 100 registered mocks',
    fast: 'matching: 0 registered mocks',
    maxRatio: 2.5,
  },
];

interface Measurement { opsPerSec: number; msPerOp: number; rme: number }
type Baseline = Record<string, Measurement>;

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padStart(s: string, n: number): string { return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const update = process.argv.includes('--update');

  const { cases, teardown } = await buildCases();

  // Warm every case before any of them is measured. tinybench warms each task
  // individually, but the Fastify and graphql-js code paths are shared, so
  // without this the first task measured absorbs the JIT cost for all of them
  // and reads 20-50% slow.
  for (let round = 0; round < 3; round++) {
    for (const c of cases) {
      for (let i = 0; i < 50; i++) await c.fn();
    }
  }

  const bench = new Bench({ time: check ? 500 : 300, warmupTime: 150 });
  for (const c of cases) bench.add(c.name, c.fn);

  await bench.run();
  await teardown();

  const results: Baseline = {};
  for (const task of bench.tasks) {
    const r = task.result;
    if (!r || r.state !== 'completed') continue;
    results[task.name] = {
      opsPerSec: Math.round(r.throughput.mean),
      msPerOp: Number(r.latency.mean.toFixed(5)),
      rme: Number(r.latency.rme.toFixed(2)),
    };
  }

  const width = Math.max(...Object.keys(results).map((k) => k.length));
  console.log(`\n${pad('case', width)}  ${padStart('ops/sec', 12)}  ${padStart('ms/op', 10)}  ${padStart('±rme', 7)}`);
  console.log('-'.repeat(width + 35));
  for (const [name, m] of Object.entries(results)) {
    console.log(
      `${pad(name, width)}  ${padStart(m.opsPerSec.toLocaleString(), 12)}  ${padStart(m.msPerOp.toFixed(4), 10)}  ${padStart(`${m.rme.toFixed(1)}%`, 7)}`,
    );
  }

  if (update || (!check && !existsSync(BASELINE))) {
    await writeFile(BASELINE, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nBaseline written to ${BASELINE}`);
    return;
  }

  if (!check) return;

  if (!existsSync(BASELINE)) {
    console.error('\nNo baseline to check against. Run `npm run bench:update` first.');
    process.exit(1);
  }

  // Invariants first: these are machine-independent, so they are the checks
  // worth trusting most.
  const broken: string[] = [];
  for (const inv of INVARIANTS) {
    const slow = results[inv.slow];
    const fast = results[inv.fast];
    if (!slow || !fast) continue;
    const ratio = slow.msPerOp / fast.msPerOp;
    if (inv.minRatio !== undefined && ratio < inv.minRatio) {
      broken.push(`  ${inv.name}: ${inv.fast} is only ${ratio.toFixed(1)}x faster than ${inv.slow} (expected >= ${inv.minRatio}x)`);
    }
    if (inv.maxRatio !== undefined && ratio > inv.maxRatio) {
      broken.push(`  ${inv.name}: ${inv.slow} is ${ratio.toFixed(2)}x ${inv.fast} (expected <= ${inv.maxRatio}x)`);
    }
  }

  const baseline = JSON.parse(await readFile(BASELINE, 'utf8')) as Baseline;
  const regressions: string[] = [];
  const missing: string[] = [];

  for (const [name, current] of Object.entries(results)) {
    const previous = baseline[name];
    if (!previous) { missing.push(name); continue; }
    const delta = (current.msPerOp - previous.msPerOp) / previous.msPerOp;
    if (delta > THRESHOLD) {
      regressions.push(
        `  ${name}: ${previous.msPerOp.toFixed(4)}ms -> ${current.msPerOp.toFixed(4)}ms (+${(delta * 100).toFixed(1)}%)`,
      );
    }
  }

  if (missing.length > 0) {
    console.log(`\nNew cases with no baseline: ${missing.join(', ')}`);
    console.log('Run `npm run bench:update` to record them.');
  }

  if (broken.length > 0) {
    console.error(`\n${broken.length} performance invariant(s) broken:`);
    console.error(broken.join('\n'));
  }

  if (regressions.length > 0) {
    console.error(`\n${regressions.length} performance regression(s) beyond ${THRESHOLD * 100}%:`);
    console.error(regressions.join('\n'));
    console.error('\nIf the trade-off is intended, re-record with `npm run bench:update`.');
  }

  if (broken.length > 0 || regressions.length > 0) process.exit(1);

  console.log(`\nInvariants hold; no regressions beyond ${THRESHOLD * 100}%.`);
}

await main();
