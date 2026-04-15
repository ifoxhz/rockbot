#!/usr/bin/env node
/**
 * Map an approximate "safe operating envelope" against push2his fflow by sweeping
 * client knobs and (optionally) multi-process aggregate rate.
 *
 * What this can reveal (empirical, not guaranteed):
 * - Whether failures drop when gaps widen (rate / burst sensitivity).
 * - Whether HTTP/2 vs HTTP/1 changes close patterns (multiplexing vs single connection).
 * - Whether N parallel Node processes (N independent client queues) triggers faster blocks
 *   (source-IP or edge concurrent-connection limits).
 *
 * What it cannot prove: exact firewall rules, scoring models, or cookie/UA fingerprints.
 * Treat results as correlation; confirm with repeats at different times.
 *
 * Usage:
 *   node scripts/probe-eastmoney-flow-envelope.mjs
 *   node scripts/probe-eastmoney-flow-envelope.mjs --iter 15 --gaps 400,800,1500,3000
 *   node scripts/probe-eastmoney-flow-envelope.mjs --iter 12 --parallel 3 --parallel-iter 10 --parallel-gap 800
 *
 * Env inherited from .env via bootstrap in child is NOT automatic — children run `node ... sustained.mjs`
 * which imports bootstrap-env. Parent should be started from repo root (same as other probes).
 */
import '../src/bootstrap-env.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SUSTAINED = path.join(ROOT, 'scripts', 'probe-eastmoney-flow-sustained.mjs');

function parseArgs(argv) {
  const out = {
    iter: 14,
    gaps: [400, 800, 1400, 2400],
    parallel: 0,
    parallelIter: 10,
    parallelGap: 800,
    codes: ['601179', '000001', '300750', '688001'],
    skipH2: false,
    h2Only: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--iter' && argv[i + 1]) {
      out.iter = Math.max(3, Number.parseInt(String(argv[(i += 1)]), 10) || 14);
      continue;
    }
    if (a === '--gaps' && argv[i + 1]) {
      out.gaps = String(argv[(i += 1)])
        .split(/[, ]+/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0);
      continue;
    }
    if (a === '--parallel' && argv[i + 1]) {
      out.parallel = Math.max(0, Number.parseInt(String(argv[(i += 1)]), 10) || 0);
      continue;
    }
    if (a === '--parallel-iter' && argv[i + 1]) {
      out.parallelIter = Math.max(2, Number.parseInt(String(argv[(i += 1)]), 10) || 10);
      continue;
    }
    if (a === '--parallel-gap' && argv[i + 1]) {
      out.parallelGap = Math.max(0, Number.parseInt(String(argv[(i += 1)]), 10) || 800);
      continue;
    }
    if (a === '--codes' && argv[i + 1]) {
      out.codes = String(argv[(i += 1)])
        .split(/[, ]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (a === '--skip-h2-sweep') {
      out.skipH2 = true;
      continue;
    }
    if (a === '--h2' && argv[i + 1]) {
      const v = String(argv[(i += 1)]).trim();
      out.h2Only = v === '1' || v.toLowerCase() === 'true' ? '1' : '0';
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      return out;
    }
  }
  return out;
}

function parseSustainedStdout(stdout) {
  const m = stdout.match(/\{\s*"startedAt"\s*:[\s\S]*\}\s*$/);
  if (!m) {
    throw new Error(`no summary JSON in stdout (len=${stdout.length})`);
  }
  return JSON.parse(m[0]);
}

function runSustained(envExtra, iter, code) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envExtra };
    const child = spawn(process.execPath, [SUSTAINED, '--iter', String(iter), '--code', String(code)], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (codeExit, signal) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      try {
        const summary = parseSustainedStdout(stdout);
        resolve({ summary, stderr, codeExit, signal });
      } catch (e) {
        reject(
          Object.assign(new Error(e.message), {
            stdoutPreview: stdout.slice(-400),
            stderrPreview: stderr.slice(0, 600),
            codeExit,
            signal,
          })
        );
      }
    });
  });
}

function rate(ok, fail) {
  const t = ok + fail;
  return t === 0 ? 0 : (100 * ok) / t;
}

const opts = parseArgs(process.argv);
if (opts.help) {
  process.stderr.write(`probe-eastmoney-flow-envelope.mjs

Sweeps EASTMONEY_MIN/MAX interval (max=min for stable cadence) and optionally EASTMONEY_ALLOW_H2.
Optional multi-process block measures aggregate pressure (separate Node = separate request queues).

  --iter N           iterations per cell per process (default 14)
  --gaps a,b,c       min=max gap list in ms (default 400,800,1400,2400)
  --skip-h2-sweep    only use current env H2 (single column)
  --h2 0|1           fix H2 instead of sweeping 0 and 1
  --parallel N       after grid, run N concurrent processes (default 0 = off)
  --parallel-iter N  iterations each parallel worker (default 10)
  --parallel-gap MS  min=max gap for parallel block (default 800)
  --codes a,b,...    rotation codes for parallel workers (default 4 sh stocks)

Prints JSON summary to stdout; progress on stderr.
`);
  process.exit(0);
}

const h2Values = opts.h2Only != null ? [opts.h2Only] : opts.skipH2 ? [process.env.EASTMONEY_ALLOW_H2 || '1'] : ['0', '1'];

const gridResults = [];

for (const gap of opts.gaps) {
  for (const h2 of h2Values) {
    const label = `gap=${gap}ms h2=${h2}`;
    process.stderr.write(`[envelope] cell ${label} (iter=${opts.iter}, code=${opts.codes[0]}) …\n`);
    const envExtra = {
      EASTMONEY_MIN_REQUEST_INTERVAL_MS: String(gap),
      EASTMONEY_MAX_REQUEST_INTERVAL_MS: String(gap),
      EASTMONEY_ALLOW_H2: h2,
      EASTMONEY_FETCH_RETRIES: process.env.EASTMONEY_FETCH_RETRIES || '3',
      EASTMONEY_BLOCK_FAILURE_THRESHOLD: process.env.EASTMONEY_BLOCK_FAILURE_THRESHOLD || '20',
    };
    try {
      const { summary, stderr, codeExit } = await runSustained(envExtra, opts.iter, opts.codes[0]);
      gridResults.push({
        kind: 'sweep',
        gapMs: gap,
        allowH2: h2,
        ok: summary.ok,
        fail: summary.fail,
        firstFailIndex: summary.firstFailIndex,
        ratePct: Number(rate(summary.ok, summary.fail).toFixed(2)),
        childExit: codeExit,
      });
    } catch (e) {
      gridResults.push({
        kind: 'sweep',
        gapMs: gap,
        allowH2: h2,
        error: e.message,
        childExit: e.codeExit,
      });
    }
  }
}

let parallelBlock = null;
if (opts.parallel > 0) {
  const g = opts.parallelGap;
  process.stderr.write(
    `[envelope] parallel block: ${opts.parallel} workers × ${opts.parallelIter} iter, gap=${g}ms, codes rotated\n`
  );
  const workers = [];
  for (let w = 0; w < opts.parallel; w += 1) {
    const code = opts.codes[w % opts.codes.length];
    const envExtra = {
      EASTMONEY_MIN_REQUEST_INTERVAL_MS: String(g),
      EASTMONEY_MAX_REQUEST_INTERVAL_MS: String(g),
      EASTMONEY_ALLOW_H2: process.env.EASTMONEY_ALLOW_H2 || '1',
      EASTMONEY_FETCH_RETRIES: process.env.EASTMONEY_FETCH_RETRIES || '3',
      EASTMONEY_BLOCK_FAILURE_THRESHOLD: process.env.EASTMONEY_BLOCK_FAILURE_THRESHOLD || '20',
    };
    workers.push(
      runSustained(envExtra, opts.parallelIter, code).then((r) => ({
        code,
        ...r.summary,
        childExit: r.codeExit,
      }))
    );
  }
  const settled = await Promise.allSettled(workers);
  let ok = 0;
  let fail = 0;
  const workerRows = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      ok += s.value.ok;
      fail += s.value.fail;
      workerRows.push({
        code: s.value.code,
        ok: s.value.ok,
        fail: s.value.fail,
        firstFailIndex: s.value.firstFailIndex,
        childExit: s.value.childExit,
      });
    } else {
      workerRows.push({ error: s.reason?.message || String(s.reason) });
    }
  }
  parallelBlock = {
    kind: 'parallel',
    workers: opts.parallel,
    gapMs: g,
    ok,
    fail,
    ratePct: Number(rate(ok, fail).toFixed(2)),
    workerRows,
  };
}

const report = {
  purpose:
    'Empirical envelope: correlate client cadence / H2 / parallel processes with close rate. Repeat at different times; not a ground-truth of server rules.',
  startedAt: new Date().toISOString(),
  options: {
    iter: opts.iter,
    gaps: opts.gaps,
    h2Values,
    parallel: opts.parallel,
    parallelIter: opts.parallelIter,
    parallelGap: opts.parallelGap,
  },
  sweep: gridResults,
  parallel: parallelBlock,
  finishedAt: new Date().toISOString(),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

// stderr: quick table
process.stderr.write('\n--- sweep (higher ratePct usually kinder to you) ---\n');
for (const r of gridResults) {
  if (r.error) {
    process.stderr.write(`  gap=${r.gapMs} h2=${r.allowH2} ERROR ${r.error}\n`);
  } else {
    process.stderr.write(
      `  gap=${r.gapMs} h2=${r.allowH2}  ok=${r.ok} fail=${r.fail}  ${r.ratePct}%  firstFail=#${r.firstFailIndex}\n`
    );
  }
}
if (parallelBlock) {
  process.stderr.write(
    `\n--- parallel ${parallelBlock.workers} workers @ ${parallelBlock.gapMs}ms → merged ok=${parallelBlock.ok} fail=${parallelBlock.fail} (${parallelBlock.ratePct}%)\n`
  );
}
