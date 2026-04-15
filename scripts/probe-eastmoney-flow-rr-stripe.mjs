#!/usr/bin/env node
/**
 * Round-robin IP test (no secid hash): EASTMONEY_PUSH2HIS_IP_PICK=round_robin,
 * EASTMONEY_PUSH2HIS_RR_STRIPE=N (default 3) → same IP for N consecutive flow requests,
 * then next IP in EASTMONEY_PUSH2HIS_IPS order (healthy-first list).
 *
 * Phase 1 — warm: one f51 request per pool IP via forcePush2hisIp (creates per-IP Agent/TCP;
 * does not advance stripe counter).
 * Phase 2 — stripe: uncached f51 through normal pick (advances stripe counter each request).
 *
 * Run (from repo root, pool in .env or env):
 *   EASTMONEY_PUSH2HIS_IPS='a,b,c,d' EASTMONEY_ALLOW_H2=1 \
 *   node scripts/probe-eastmoney-flow-rr-stripe.mjs --iter 24 --stripe 3
 */
import '../src/bootstrap-env.js';
import net from 'node:net';

function parsePoolFromEnv() {
  const raw = process.env.EASTMONEY_PUSH2HIS_IPS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  const out = [];
  for (const part of String(raw).split(/[\s,]+/)) {
    const ip = part.trim();
    if (ip && net.isIP(ip)) out.push(ip);
  }
  return out;
}

function parseArgs(argv) {
  const out = { iter: 24, stripe: 3, code: '601179', days: 25, skipWarm: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--iter' && argv[i + 1]) {
      out.iter = Math.max(1, Number.parseInt(String(argv[(i += 1)]), 10) || 24);
      continue;
    }
    if (a === '--stripe' && argv[i + 1]) {
      out.stripe = Math.max(1, Number.parseInt(String(argv[(i += 1)]), 10) || 3);
      continue;
    }
    if (a === '--code' && argv[i + 1]) {
      out.code = String(argv[(i += 1)]).trim();
      continue;
    }
    if (a === '--days' && argv[i + 1]) {
      out.days = Math.max(1, Number.parseInt(String(argv[(i += 1)]), 10) || 25);
      continue;
    }
    if (a === '--skip-warm') {
      out.skipWarm = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      return out;
    }
  }
  return out;
}

const opts = parseArgs(process.argv);
if (opts.help) {
  process.stderr.write(`probe-eastmoney-flow-rr-stripe.mjs  [--iter N] [--stripe N] [--code C] [--days D] [--skip-warm]\n`);
  process.exit(0);
}

process.env.EASTMONEY_PUSH2HIS_IP_PICK = 'round_robin';
process.env.EASTMONEY_PUSH2HIS_RR_STRIPE = String(opts.stripe);
if (!process.env.EASTMONEY_ALLOW_H2) {
  process.env.EASTMONEY_ALLOW_H2 = '1';
}

const pool = parsePoolFromEnv();
if (pool.length < 2) {
  process.stderr.write(
    '[probe rr-stripe] Need at least 2 IPs in EASTMONEY_PUSH2HIS_IPS (got ' +
      pool.length +
      ').\n'
  );
  process.exit(1);
}

const {
  probeEastmoneyFlowF51Uncached,
  probeEastmoneyFlowF51UncachedOnIp,
  resetEastmoneyPush2hisStripeCounterForProbe,
  peekEastmoneyLastTcpDialHost,
  previewEastmoneyFlowDialForCode,
} = await import('../src/services/eastmoneyDailyFlow.js');

const summary = {
  mode: 'round_robin',
  stripe: opts.stripe,
  pool,
  code: opts.code,
  warm: [],
  main: [],
  ok: 0,
  fail: 0,
};

resetEastmoneyPush2hisStripeCounterForProbe();

if (!opts.skipWarm) {
  process.stderr.write(`[probe rr-stripe] warm: ${pool.length} IPs (one f51 each, forced) …\n`);
  for (const ip of pool) {
    const t0 = Date.now();
    try {
      const rows = await probeEastmoneyFlowF51UncachedOnIp(opts.code, opts.days, ip);
      summary.warm.push({
        ip,
        ok: true,
        rows: Array.isArray(rows) ? rows.length : 0,
        dial: peekEastmoneyLastTcpDialHost(),
        ms: Date.now() - t0,
      });
    } catch (err) {
      summary.warm.push({
        ip,
        ok: false,
        dial: peekEastmoneyLastTcpDialHost(),
        message: err?.message,
        causeCode: err?.cause?.code,
        ms: Date.now() - t0,
      });
    }
    process.stderr.write(
      `  warm ip=${ip} ok=${summary.warm[summary.warm.length - 1].ok} dial=${peekEastmoneyLastTcpDialHost()} ${summary.warm[summary.warm.length - 1].ms}ms\n`
    );
  }
}

resetEastmoneyPush2hisStripeCounterForProbe();

process.stderr.write(
  `[probe rr-stripe] main: ${opts.iter} requests, stripe=${opts.stripe} (same IP ×${opts.stripe} then next in pool order) …\n`
);

for (let i = 1; i <= opts.iter; i += 1) {
  const nextDial = previewEastmoneyFlowDialForCode(opts.code);
  const t0 = Date.now();
  try {
    const rows = await probeEastmoneyFlowF51Uncached(opts.code, opts.days);
    summary.ok += 1;
    const rec = {
      i,
      expectedIp: nextDial.tcpDialIp,
      dial: peekEastmoneyLastTcpDialHost(),
      ok: true,
      rows: Array.isArray(rows) ? rows.length : 0,
      ms: Date.now() - t0,
    };
    summary.main.push(rec);
    process.stderr.write(
      `#${i} ok expected=${rec.expectedIp} dial=${rec.dial} rows=${rec.rows} ${rec.ms}ms\n`
    );
  } catch (err) {
    summary.fail += 1;
    const rec = {
      i,
      expectedIp: nextDial.tcpDialIp,
      dial: peekEastmoneyLastTcpDialHost(),
      ok: false,
      message: err?.message,
      causeCode: err?.cause?.code,
      ms: Date.now() - t0,
    };
    summary.main.push(rec);
    process.stderr.write(
      `#${i} FAIL expected=${rec.expectedIp} dial=${rec.dial} ${rec.causeCode || rec.message}\n`
    );
  }
}

summary.finishedAt = new Date().toISOString();
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
