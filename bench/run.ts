import { Bench } from 'tinybench';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCases } from './suites.js';

const BASELINE = resolve(import.meta.dirname, 'baseline.json');
/** How much slower than the baseline a case may get before the build fails. */
const THRESHOLD = 0.1;

interface Measurement { opsPerSec: number; msPerOp: number; rme: number }
type Baseline = Record<string, Measurement>;

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padStart(s: string, n: number): string { return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const update = process.argv.includes('--update');

  const { cases, teardown } = await buildCases();
  const bench = new Bench({ time: check ? 400 : 250, warmupTime: 100 });
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

  if (regressions.length > 0) {
    console.error(`\n${regressions.length} performance regression(s) beyond ${THRESHOLD * 100}%:`);
    console.error(regressions.join('\n'));
    console.error('\nIf the trade-off is intended, re-record with `npm run bench:update`.');
    process.exit(1);
  }

  console.log(`\nNo regressions beyond ${THRESHOLD * 100}%.`);
}

await main();
