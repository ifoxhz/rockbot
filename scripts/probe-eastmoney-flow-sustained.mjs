#!/usr/bin/env node
/**
 * Sustained probe for push2his fflow/kline/get (fields2=f51), same stack as production.
 *
 * Use this to see whether failures (e.g. UND_ERR_SOCKET / peer closed) correlate with
 * request count on one TCP/IP path vs periodic agent reset or rotating stock codes
 * (different secid → different pool IP when EASTMONEY_PUSH2HIS_IPS has multiple entries).
 *
 * Examples:
 *   npm run probe:eastmoney:flow:sustained -- --iter 60 --code 601179
 *   npm run probe:eastmoney:flow:sustained -- --iter 60 --codes 601179,000001,300750,688001
 *   npm run probe:eastmoney:flow:sustained -- --iter 60 --code 601179 --reset-every 10
 *
 * Tuning (env): EASTMONEY_PUSH2HIS_IPS, EASTMONEY_MIN_REQUEST_INTERVAL_MS (0 for faster repro),
 * EASTMONEY_FETCH_RETRIES, EASTMONEY_DEBUG=1
 */
import '../src/bootstrap-env.js';
import {
  probeEastmoneyFlowF51Uncached,
  resetEastmoneyNetworkStateForProbe,
  previewEastmoneyFlowDialForCode,
} from '../src/services/eastmoneyDailyFlow.js';

function parseArgs(argv) {
  const out = {
    iterations: 50,
    days: 25,
    delayMs: null,
    resetEvery: 0,
    codes: null,
    code: '601179',
    jsonl: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--iter' && argv[i + 1]) {
      out.iterations = Math.max(1, Number.parseInt(String(argv[(i += 1)]), 10) || 50);
      continue;
    }
    if (a === '--days' && argv[i + 1]) {
      out.days = Math.max(1, Number.parseInt(String(argv[(i += 1)]), 10) || 25);
      continue;
    }
    if (a === '--delay-ms' && argv[i + 1]) {
      out.delayMs = Math.max(0, Number.parseInt(String(argv[(i += 1)]), 10) || 0);
      continue;
    }
    if (a === '--reset-every' && argv[i + 1]) {
      out.resetEvery = Math.max(0, Number.parseInt(String(argv[(i += 1)]), 10) || 0);
      continue;
    }
    if (a === '--codes' && argv[i + 1]) {
      out.codes = String(argv[(i += 1)])
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (a === '--code' && argv[i + 1]) {
      out.code = String(argv[(i += 1)]).trim();
      continue;
    }
    if (a === '--jsonl') {
      out.jsonl = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      return out;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const opts = parseArgs(process.argv);
if (opts.help) {
  process.stderr.write(
    `Usage: probe-eastmoney-flow-sustained.mjs [options]\n` +
      `  --code CODE          single stock (default 601179)\n` +
      `  --codes A,B,C        rotate codes each iteration (tests different secid → different pool IP)\n` +
      `  --iter N             iterations (default 50)\n` +
      `  --days N             lmt= (default 25)\n` +
      `  --reset-every N      after N successful fetches, reset all undici agents (0=off)\n` +
      `  --delay-ms MS        extra sleep after each iteration (default: none; queue still applies)\n` +
      `  --jsonl              one JSON object per line to stdout\n`
  );
  process.exit(0);
}

const codeList = opts.codes && opts.codes.length > 0 ? opts.codes : [opts.code];
const summary = {
  startedAt: new Date().toISOString(),
  iterations: opts.iterations,
  days: opts.days,
  resetEvery: opts.resetEvery,
  codes: codeList,
  ok: 0,
  fail: 0,
  resets: 0,
  firstFailIndex: null,
  errors: [],
};

let successSinceReset = 0;

for (let i = 1; i <= opts.iterations; i += 1) {
  const code = codeList[(i - 1) % codeList.length];
  const dial = previewEastmoneyFlowDialForCode(code);
  const t0 = Date.now();
  try {
    const rows = await probeEastmoneyFlowF51Uncached(code, opts.days);
    const elapsedMs = Date.now() - t0;
    summary.ok += 1;
    successSinceReset += 1;
    const row = {
      i,
      code,
      secid: dial.secid,
      tcpDialIp: dial.tcpDialIp,
      ok: true,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      elapsedMs,
    };
    if (opts.jsonl) {
      process.stdout.write(`${JSON.stringify(row)}\n`);
    } else {
      process.stderr.write(
        `[probe flow sustained] #${i} ok code=${code} secid=${dial.secid} ip=${dial.tcpDialIp ?? 'dns'} rows=${row.rowCount} ${elapsedMs}ms\n`
      );
    }
    if (opts.resetEvery > 0 && successSinceReset >= opts.resetEvery) {
      await resetEastmoneyNetworkStateForProbe();
      successSinceReset = 0;
      summary.resets += 1;
      if (!opts.jsonl) {
        process.stderr.write(`[probe flow sustained] reset agents (reset-every=${opts.resetEvery})\n`);
      }
    }
  } catch (err) {
    summary.fail += 1;
    if (summary.firstFailIndex === null) summary.firstFailIndex = i;
    const causeCode = err?.cause?.code ?? null;
    const rec = {
      i,
      code,
      secid: dial.secid,
      tcpDialIp: dial.tcpDialIp,
      ok: false,
      message: err?.message,
      causeCode,
      elapsedMs: Date.now() - t0,
    };
    summary.errors.push(rec);
    if (opts.jsonl) {
      process.stdout.write(`${JSON.stringify(rec)}\n`);
    } else {
      process.stderr.write(
        `[probe flow sustained] #${i} FAIL code=${code} ip=${dial.tcpDialIp ?? 'dns'} ${causeCode || err?.message}\n`
      );
    }
  }
  if (opts.delayMs != null && opts.delayMs > 0) {
    await sleep(opts.delayMs);
  }
}

summary.finishedAt = new Date().toISOString();
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
