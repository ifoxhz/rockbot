#!/usr/bin/env node
import '../src/bootstrap-env.js';
import {
  fetchEastmoneyDailyKlinesViaBrowser,
  closeEastmoneyBrowser,
} from '../src/services/eastmoneyBrowserClient.js';

function parseArgs(argv) {
  const out = {
    codes: [],
    days: 25,
    pool: [],
    jsonl: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--codes' && argv[i + 1]) {
      out.codes.push(
        ...String(argv[(i += 1)])
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
      continue;
    }
    if (a === '--days' && argv[i + 1]) {
      out.days = Math.max(1, Number.parseInt(String(argv[(i += 1)]), 10) || 25);
      continue;
    }
    if (a === '--ips' && argv[i + 1]) {
      out.pool = String(argv[(i += 1)])
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
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
    if (!a.startsWith('-')) {
      out.codes.push(...a.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

function normalizeCode(raw) {
  const code = String(raw || '').trim();
  if (!/^\d{6}$/.test(code)) return null;
  return code;
}

function expandRange(start, end) {
  const left = normalizeCode(start);
  const right = normalizeCode(end);
  if (!left || !right) return [];
  const width = Math.max(left.length, right.length);
  const a = Number(left);
  const b = Number(right);
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const out = [];
  for (let i = low; i <= high; i += 1) {
    out.push(String(i).padStart(width, '0'));
  }
  return out;
}

function secidOf(code) {
  return code.startsWith('6') ? `1.${code}` : `0.${code}`;
}

function parsePoolFromEnv() {
  const raw = String(process.env.EASTMONEY_PUSH2HIS_IPS || '').trim();
  if (!raw) return [];
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function parseEmbeddedKlineFailurePayload(message) {
  const s = String(message || '');
  const mark = 'Eastmoney browser kline JSONP failed after retries: ';
  const idx = s.indexOf(mark);
  if (idx < 0) return null;
  const jsonText = s.slice(idx + mark.length).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv);
if (args.help) {
  process.stderr.write(
    `Usage: probe-eastmoney-kline-turnover.mjs [codes...] [options]\n` +
      `  codes                one or more stock codes, e.g. 601179 601190\n` +
      `                      when exactly two codes are given, treat as inclusive range\n` +
      `                      e.g. 300040 300080 => 300040..300080\n` +
      `  --codes A,B,C        codes list (same as positional)\n` +
      `  --days N             kline days (default 25)\n` +
      `  --ips IP1,IP2,...    override IP pool for domain mapping test\n` +
      `  --jsonl              print each probe row as JSONL\n\n` +
      `Core improvement under test:\n` +
      `  URL keeps https://push2his.eastmoney.com, but each run maps DNS to one target IP\n` +
      `  by setting EASTMONEY_PUSH2HIS_IPS=<single-ip> and relaunching browser.\n`
  );
  process.exit(0);
}

const codes = [...new Set(args.codes.map(normalizeCode).filter(Boolean))];
if (codes.length === 2) {
  const maybeRange = expandRange(codes[0], codes[1]);
  if (maybeRange.length > 2) {
    codes.length = 0;
    codes.push(...maybeRange);
  }
}
if (codes.length === 0) {
  process.stderr.write('No valid stock codes provided. Example: 601179 601190\n');
  process.exit(1);
}

const pool = args.pool.length > 0 ? args.pool : parsePoolFromEnv();
const ipTargets = pool.length > 0 ? pool : [null];
const originalIpsEnv = process.env.EASTMONEY_PUSH2HIS_IPS;
const originalResolveEnv = process.env.EASTMONEY_BROWSER_RESOLVE_PUSH2HIS_IP;

const rows = [];
const summary = {
  startedAt: new Date().toISOString(),
  days: args.days,
  codes,
  ipTargets: ipTargets.map((ip) => ip || 'dns-default'),
  total: 0,
  ok: 0,
  fail: 0,
  responseOk: 0,
  responseFail: 0,
  byIp: {},
};

for (const ip of ipTargets) {
  if (ip) {
    // Force one target IP for this sub-run: host-resolver maps domain to this IP.
    process.env.EASTMONEY_PUSH2HIS_IPS = ip;
    process.env.EASTMONEY_BROWSER_RESOLVE_PUSH2HIS_IP = ip;
  } else {
    delete process.env.EASTMONEY_BROWSER_RESOLVE_PUSH2HIS_IP;
  }
  await closeEastmoneyBrowser();

  for (const code of codes) {
    const secid = secidOf(code);
    const t0 = Date.now();
    summary.total += 1;
    try {
      const klines = await fetchEastmoneyDailyKlinesViaBrowser(secid, args.days);
      const last = klines[klines.length - 1] || null;
      const ok =
        Boolean(last) &&
        Number.isFinite(Number(last?.change_pct)) &&
        Number.isFinite(Number(last?.turnover_rate));
      const rec = {
        code,
        secid,
        ip: ip || 'dns-default',
        ok,
        count: Array.isArray(klines) ? klines.length : 0,
        elapsedMs: Date.now() - t0,
        date: last?.date ?? null,
        change_pct: last?.change_pct ?? null,
        turnover_rate: last?.turnover_rate ?? null,
      };
      rows.push(rec);
      summary.responseOk += 1;
      if (ok) summary.ok += 1;
      else summary.fail += 1;
      if (args.jsonl) process.stdout.write(`${JSON.stringify(rec)}\n`);
    } catch (err) {
      const payload = parseEmbeddedKlineFailurePayload(err?.message);
      const responseOk = Boolean(payload?.ok);
      const networkStatus =
        typeof payload?.networkResult?.status === 'number' ? payload.networkResult.status : null;
      const rec = {
        code,
        secid,
        ip: ip || 'dns-default',
        // New criterion: any server response body/callback is considered transport-success.
        ok: responseOk,
        dataOk: false,
        responseOk,
        networkStatus,
        rc: payload?.payload?.rc ?? null,
        elapsedMs: Date.now() - t0,
        message: err?.message,
        name: err?.name,
      };
      rows.push(rec);
      if (responseOk) {
        summary.ok += 1;
        summary.responseOk += 1;
      } else {
        summary.fail += 1;
        summary.responseFail += 1;
      }
      if (args.jsonl) process.stdout.write(`${JSON.stringify(rec)}\n`);
    }
  }
}

await closeEastmoneyBrowser();
if (originalIpsEnv === undefined) delete process.env.EASTMONEY_PUSH2HIS_IPS;
else process.env.EASTMONEY_PUSH2HIS_IPS = originalIpsEnv;
if (originalResolveEnv === undefined) delete process.env.EASTMONEY_BROWSER_RESOLVE_PUSH2HIS_IP;
else process.env.EASTMONEY_BROWSER_RESOLVE_PUSH2HIS_IP = originalResolveEnv;

for (const ip of summary.ipTargets) {
  const hit = rows.filter((r) => r.ip === ip);
  const ok = hit.filter((r) => r.ok).length;
  summary.byIp[ip] = {
    total: hit.length,
    ok,
    fail: hit.length - ok,
    responseOk: hit.filter((r) => r.responseOk || r.ok).length,
  };
}
summary.finishedAt = new Date().toISOString();
summary.rows = rows;

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
