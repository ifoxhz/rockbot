// src/services/eastmoneyDailyFlow.js
//
// Optional env:
// - EASTMONEY_CACHE_TTL_MS: in-memory cache TTL (ms), 0 = off (default 120000)
// - EASTMONEY_COOKIE: optional Cookie header (login / session)
// - EASTMONEY_REFERER: override Referer
// - EASTMONEY_USER_AGENT: fixed UA (overrides UA pool)
// - EASTMONEY_UA_STRATEGY: hash | random — per-secid stable vs random UA per request (default hash)
// - EASTMONEY_MAX_CONNECTIONS: undici Agent pool size (default 6)
// - EASTMONEY_MIN_REQUEST_INTERVAL_MS: min gap between requests (default 1200)
// - EASTMONEY_MAX_REQUEST_INTERVAL_MS: max gap between requests (default 2800)
// - EASTMONEY_DISABLE_UNDICI=1: use global fetch (no HTTP/2 / shared pool)
// - EASTMONEY_BATCH_CONCURRENCY: default for fetchDailyFundFlowBatch (default 3)
// - EASTMONEY_PUSH2HIS_IPS: comma/space-separated IPs (undici only). Unset or empty → DNS only.
//   Request URL / logs still show https://push2his.eastmoney.com/... (correct Host + SNI); TCP dials
//   the rotated IP. Used for flow requests only; daily change_pct / turnover_rate are supplemented
//   by Tushare because Eastmoney kline is not stable enough here.
// - EASTMONEY_PUSH2HIS_HOST: override canonical host (default push2his.eastmoney.com)
// - EASTMONEY_CONNECT_TIMEOUT_MS: undici connector timeout (default 10000)
// - EASTMONEY_REQUEST_TIMEOUT_MS: total fetch timeout per attempt (default 15000)
// - EASTMONEY_KEEPALIVE_TIMEOUT_MS: pooled socket idle timeout (default 15000)
// - EASTMONEY_KEEPALIVE_MAX_TIMEOUT_MS: max server-advertised keepalive cap (default 60000)
// - EASTMONEY_IP_HEALTH_COOLDOWN_MS: mark an IP unavailable after socket-like failures (default 300000)
// - EASTMONEY_BLOCK_COOLDOWN_MS: global cooldown after repeated transient failures (default 180000)
// - EASTMONEY_BLOCK_FAILURE_THRESHOLD: consecutive transient failures before cooldown (default 6)
// - EASTMONEY_LIMIT_HIT_COOLDOWN_MS: cooldown after 403/429/block-page detection (default 900000)
// - EASTMONEY_DYNAMIC_DELAY_STEP_MS: additional gap after each limit hit (default 1500)
// - EASTMONEY_DYNAMIC_DELAY_MAX_MS: cap for additional gap after repeated limit hits (default 30000)
// - EASTMONEY_ALLOW_H2: 1=true, 0=false. Default: direct=true, proxy=false
// - HTTP_PROXY / HTTPS_PROXY / NO_PROXY (or lowercase): when set, requests go through proxy
//   via undici EnvHttpProxyAgent. In proxy mode, EASTMONEY_PUSH2HIS_IPS is ignored.
//
// Undici / `node:undici`:
// Node uses undici internally for global fetch(), but many official binaries do NOT
// register `node:undici` as an importable built-in → ERR_UNKNOWN_BUILTIN_MODULE.
// That is expected on some versions; Node has suggested using npm `undici` when you
// need Agent/dispatcher (e.g. nodejs/node#54437). We try `node:undici`, then npm
// `undici`, then global fetch — no static import so startup never hard-fails.

import net from 'node:net';
import vm from 'node:vm';
import {
  fetchEastmoneyDailyKlinesViaBrowser,
  fetchEastmoneyRealtimeQuoteViaBrowser,
} from './eastmoneyBrowserClient.js';

const EASTMONEY_FLOW_URL =
  'https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get';
const EASTMONEY_KLINE_URL =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const EASTMONEY_DEFAULT_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const EASTMONEY_FETCH_RETRIES = Math.max(
  1,
  Number.parseInt(String(process.env.EASTMONEY_FETCH_RETRIES || '4'), 10) || 4
);
const EASTMONEY_CACHE_TTL_MS = Math.max(
  0,
  Number.parseInt(String(process.env.EASTMONEY_CACHE_TTL_MS ?? '120000'), 10) || 0
);
const EASTMONEY_CACHE_MAX_ENTRIES = Math.max(
  50,
  Number.parseInt(String(process.env.EASTMONEY_CACHE_MAX_ENTRIES || '400'), 10) || 400
);
const EASTMONEY_BATCH_CONCURRENCY_DEFAULT = Math.max(
  1,
  Number.parseInt(String(process.env.EASTMONEY_BATCH_CONCURRENCY || '3'), 10) || 3
);
const EASTMONEY_MIN_REQUEST_INTERVAL_MS = Math.max(
  0,
  Number.parseInt(String(process.env.EASTMONEY_MIN_REQUEST_INTERVAL_MS || '1200'), 10) || 1200
);
const EASTMONEY_MAX_REQUEST_INTERVAL_MS = Math.max(
  EASTMONEY_MIN_REQUEST_INTERVAL_MS,
  Number.parseInt(String(process.env.EASTMONEY_MAX_REQUEST_INTERVAL_MS || '2800'), 10) || 2800
);
const EASTMONEY_REQUEST_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(String(process.env.EASTMONEY_REQUEST_TIMEOUT_MS || '15000'), 10) || 15_000
);
const EASTMONEY_KEEPALIVE_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(String(process.env.EASTMONEY_KEEPALIVE_TIMEOUT_MS || '15000'), 10) || 15_000
);
const EASTMONEY_KEEPALIVE_MAX_TIMEOUT_MS = Math.max(
  EASTMONEY_KEEPALIVE_TIMEOUT_MS,
  Number.parseInt(String(process.env.EASTMONEY_KEEPALIVE_MAX_TIMEOUT_MS || '60000'), 10) ||
    60_000
);
const EASTMONEY_IP_HEALTH_COOLDOWN_MS = Math.max(
  30_000,
  Number.parseInt(String(process.env.EASTMONEY_IP_HEALTH_COOLDOWN_MS || '300000'), 10) || 300_000
);
const EASTMONEY_BLOCK_COOLDOWN_MS = Math.max(
  30_000,
  Number.parseInt(String(process.env.EASTMONEY_BLOCK_COOLDOWN_MS || '180000'), 10) || 180_000
);
const EASTMONEY_BLOCK_FAILURE_THRESHOLD = Math.max(
  2,
  Number.parseInt(String(process.env.EASTMONEY_BLOCK_FAILURE_THRESHOLD || '6'), 10) || 6
);
const EASTMONEY_LIMIT_HIT_COOLDOWN_MS = Math.max(
  30_000,
  Number.parseInt(String(process.env.EASTMONEY_LIMIT_HIT_COOLDOWN_MS || '900000'), 10) || 900_000
);
const EASTMONEY_DYNAMIC_DELAY_STEP_MS = Math.max(
  0,
  Number.parseInt(String(process.env.EASTMONEY_DYNAMIC_DELAY_STEP_MS || '1500'), 10) || 1_500
);
const EASTMONEY_DYNAMIC_DELAY_MAX_MS = Math.max(
  EASTMONEY_DYNAMIC_DELAY_STEP_MS,
  Number.parseInt(String(process.env.EASTMONEY_DYNAMIC_DELAY_MAX_MS || '30000'), 10) || 30_000
);
const EASTMONEY_DEBUG = process.env.EASTMONEY_DEBUG === '1';

/** @type {Map<string, { expiresAt: number, value: unknown }>} */
const eastmoneyMemoryCache = new Map();
/** @type {Map<string, Promise<unknown>>} */
const eastmoneyInflight = new Map();

let eastmoneyRequestQueue = Promise.resolve();
let lastEastmoneyRequestAt = 0;
let eastmoneyConsecutiveTransientFailures = 0;
let eastmoneyGlobalCooldownUntil = 0;
let eastmoneyDynamicDelayMs = 0;

let eastmoneyAgent = null;
let eastmoneyAgentMode = null;
let eastmoneyScriptAgent = null;
/** @type {Map<string, unknown>} */
let eastmoneyIpAgents = new Map();
/** @type {Promise<import('undici') | null>} */
let eastmoneyUndiciModulePromise = null;

let warnedPush2hisIpsWithoutUndici = false;
let warnedProxyWithoutUndici = false;
let eastmoneyLoggedProxyConfig = false;

const EASTMONEY_PUSH2HIS_CANONICAL_HOST = (
  process.env.EASTMONEY_PUSH2HIS_HOST || 'push2his.eastmoney.com'
)
  .trim()
  .toLowerCase();

function parseEastmoneyPush2hisIpsFromEnv() {
  const raw = process.env.EASTMONEY_PUSH2HIS_IPS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  const out = [];
  for (const part of raw.split(/[\s,]+/)) {
    const ip = part.trim();
    if (!ip) continue;
    if (net.isIP(ip)) out.push(ip);
  }
  return out;
}

let eastmoneyPush2hisIpRoundRobin = 0;
/** @type {Map<string, { unhealthyUntil: number, failCount: number, lastError?: string }>} */
const eastmoneyIpHealth = new Map();

/** Last TCP connect target (rotated IP or hostname); for logs only, may race under concurrency. */
let eastmoneyLastTcpDialHost = null;

let eastmoneyLoggedPush2hisIpPool = false;
let eastmoneyRequestSeq = 0;

/**
 * Custom undici connector: connect to a fixed IP while keeping
 * TLS SNI / servername as the real hostname so the certificate validates.
 */
function createEastmoneyPush2hisConnector(undiciMod, fixedIp) {
  if (!fixedIp) return null;
  const buildConnector = undiciMod.buildConnector;
  if (typeof buildConnector !== 'function') return null;

  const host = EASTMONEY_PUSH2HIS_CANONICAL_HOST;
  const connectTimeout =
    Number.parseInt(String(process.env.EASTMONEY_CONNECT_TIMEOUT_MS || '10000'), 10) || 10_000;

  const inner = buildConnector({
    allowH2: eastmoneyAllowH2(false),
    timeout: connectTimeout,
    keepAlive: true,
    keepAliveInitialDelay: 60_000,
  });

  return function eastmoneyFixedPush2hisConnect(opts, callback) {
    if (opts.hostname === host) {
      eastmoneyLastTcpDialHost = fixedIp;
      return inner({ ...opts, hostname: fixedIp }, callback);
    }
    eastmoneyLastTcpDialHost = opts.hostname;
    return inner(opts, callback);
  };
}

function getConfiguredProxyUrl() {
  return (getEastmoneyProxyConfig().httpsProxy || getEastmoneyProxyConfig().httpProxy || '').trim();
}

function getEastmoneyProxyConfig() {
  // Follow undici EnvHttpProxyAgent precedence: lowercase wins over uppercase.
  const httpProxy = (process.env.http_proxy || process.env.HTTP_PROXY || '').trim();
  const httpsProxy = (process.env.https_proxy || process.env.HTTPS_PROXY || '').trim();
  const noProxy = (process.env.no_proxy || process.env.NO_PROXY || '').trim();
  return {
    httpProxy,
    httpsProxy,
    noProxy,
  };
}

function parseEastmoneyBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function eastmoneyAllowH2(proxyEnabled) {
  return parseEastmoneyBoolean(process.env.EASTMONEY_ALLOW_H2, !proxyEnabled);
}

function getAvailableEastmoneyPush2hisIps() {
  const ips = parseEastmoneyPush2hisIpsFromEnv();
  if (ips.length === 0) return [];
  const now = Date.now();
  const healthy = ips.filter((ip) => {
    const health = eastmoneyIpHealth.get(ip);
    return !health || health.unhealthyUntil <= now;
  });
  return healthy.length > 0 ? healthy : ips;
}

function pickEastmoneyPush2hisIp(secid) {
  const ips = getAvailableEastmoneyPush2hisIps();
  if (ips.length === 0) return null;
  if (!secid) {
    const ip = ips[eastmoneyPush2hisIpRoundRobin++ % ips.length];
    return ip;
  }
  const idx = Math.abs(simpleHash32(secid)) % ips.length;
  return ips[idx];
}

function markEastmoneyIpFailure(ip, err) {
  if (!ip) return;
  const prev = eastmoneyIpHealth.get(ip) || { unhealthyUntil: 0, failCount: 0 };
  const failCount = prev.failCount + 1;
  const unhealthyUntil = Date.now() + EASTMONEY_IP_HEALTH_COOLDOWN_MS;
  eastmoneyIpHealth.set(ip, {
    unhealthyUntil,
    failCount,
    lastError: err?.cause?.code || err?.message || String(err),
  });
  logEastmoneyError('push2his ip marked unhealthy', {
    ip,
    failCount,
    unhealthyForMs: EASTMONEY_IP_HEALTH_COOLDOWN_MS,
    lastError: err?.cause?.code || err?.message,
  });
}

function clearEastmoneyIpFailure(ip) {
  if (!ip) return;
  const prev = eastmoneyIpHealth.get(ip);
  if (!prev) return;
  if (prev.failCount <= 1) {
    eastmoneyIpHealth.delete(ip);
    return;
  }
  eastmoneyIpHealth.set(ip, {
    unhealthyUntil: 0,
    failCount: Math.max(0, prev.failCount - 1),
    lastError: prev.lastError,
  });
}

function eastmoneyTcpDialLogFields() {
  const proxy = getConfiguredProxyUrl();
  if (proxy) {
    return {
      viaProxy: true,
      proxy,
    };
  }

  const pool = parseEastmoneyPush2hisIpsFromEnv();
  if (pool.length === 0) return {};
  return {
    tcpDialHost: eastmoneyLastTcpDialHost,
    tlsServername: EASTMONEY_PUSH2HIS_CANONICAL_HOST,
    tcpDialPool: pool,
  };
}

function loadEastmoneyUndiciModule() {
  if (!eastmoneyUndiciModulePromise) {
    eastmoneyUndiciModulePromise = (async () => {
      try {
        return await import('node:undici');
      } catch {
        try {
          return await import('undici');
        } catch {
          return null;
        }
      }
    })();
  }
  return eastmoneyUndiciModulePromise;
}

/**
 * Fetch raw daily fund flow data from Eastmoney
 * @param {string} code e.g. "600519"
 * @param {number} days default 30
 */
export async function fetchDailyFundFlow(code, days = 25) {
  const secid = normalizeSecId(code);

  const flowRows = await fetchFlowRows({
    secid,
    days,
  });
  const marketRows = await fetchDailyMarketData({
    secid,
    days,
  });
  const dailyMap = new Map(marketRows.map((row) => [row.date, row]));

  return flowRows.map((row) => {
    const marketRow = dailyMap.get(row.date) || null;
    return {
      date: row.date,
      main_net: row.main_net,
      main_net_ratio: row.main_net_ratio,
      small_net_ratio: row.small_net_ratio,
      open: dailyMap.get(row.date)?.open ?? null,
      close: dailyMap.get(row.date)?.close ?? null,
      high: dailyMap.get(row.date)?.high ?? null,
      low: dailyMap.get(row.date)?.low ?? null,
      volume: dailyMap.get(row.date)?.volume ?? null,
      total_amount: dailyMap.get(row.date)?.total_amount ?? null,
      amplitude: dailyMap.get(row.date)?.amplitude ?? null,
      small: row.small,
      medium: row.medium,
      large: row.large,
      extra_large: row.extra_large,
      change_pct: dailyMap.get(row.date)?.change_pct ?? null,
      change_amount: dailyMap.get(row.date)?.change_amount ?? null,
      turnover_rate: dailyMap.get(row.date)?.turnover_rate ?? null,
      market_data_source: marketRow?.source || null,
    };
  });
}

/**
 * Multiple symbols with bounded parallelism. APIs remain one request per secid;
 * benefits: shared Agent (keep-alive / HTTP/2), queue, and in-memory cache.
 *
 * @param {string[]} codes
 * @param {number} [days]
 * @param {{ concurrency?: number }} [opts]
 */
export async function fetchDailyFundFlowBatch(codes, days = 25, opts = {}) {
  const list = Array.isArray(codes) ? codes : [];
  const concurrency = Math.max(
    1,
    Number(opts.concurrency) || EASTMONEY_BATCH_CONCURRENCY_DEFAULT
  );
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= list.length) break;
      const code = list[i];
      try {
        const data = await fetchDailyFundFlow(code, days);
        results[i] = { code, ok: true, data };
      } catch (err) {
        results[i] = {
          code,
          ok: false,
          error: err?.message || String(err),
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, () => worker())
  );
  return results;
}

/**
 * Normalize raw flow values:
 * - unit: million
 * - negative = sell dominant
 */
export function normalizeDailyFlow(rows) {
  return rows.map((row) => ({
    date: row.date,
    main_net: toMillionOrNull(row.main_net),
    main_net_ratio: row.main_net_ratio,
    small_net_ratio: row.small_net_ratio,
    open: row.open,
    close: row.close,
    high: row.high,
    low: row.low,
    volume: row.volume,
    total_amount: toMillionOrNull(row.total_amount),
    amplitude: row.amplitude,
    small: toMillionOrNull(row.small),
    medium: toMillionOrNull(row.medium),
    large: toMillionOrNull(row.large),
    extra_large: toMillionOrNull(row.extra_large),
    change_pct: row.change_pct,
    change_amount: row.change_amount,
    turnover_rate: row.turnover_rate,
    market_data_source: row.market_data_source || null,
    unit: 'million',
    currency: 'CNY',
    source: 'eastmoney',
  }));
}

/* ---------------- helpers ---------------- */

async function fetchKlines(args) {
  const { secid, days, fields2 } = args;
  const key = cacheKeyFlow(secid, days, fields2);
  return getOrFetchCached(key, () => fetchKlinesUncached(args));
}

async function fetchFlowRows(args) {
  try {
    const rows = await fetchKlines({
      ...args,
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
    });

    return rows.map((parts) => ({
      date: parts[0],
      main_net: parts[1],
      small: parts[2],
      medium: parts[3],
      large: parts[4],
      extra_large: parts[5],
      main_net_ratio: parts[6],
      small_net_ratio: parts[7],
    }));
  } catch (err) {
    logEastmoneyError('fetchFlowRows extended fields failed, falling back to base fields', {
      secid: args?.secid,
      days: args?.days,
      message: err?.message,
    });
    const dates = await fetchKlines({
      ...args,
      fields2: 'f51',
    });
    const rows = await fetchKlines({
      ...args,
      fields2: 'f53,f54,f55,f56',
    });

    return dates.map((date, index) => {
      const [small, medium, large, extraLarge] = rows[index] || [0, 0, 0, 0];
      return {
        date,
        main_net: Number(large || 0) + Number(extraLarge || 0),
        small,
        medium,
        large,
        extra_large: extraLarge,
        main_net_ratio: null,
        small_net_ratio: null,
      };
    });
  }
}

async function fetchKlinesUncached({ secid, days, fields2 }) {
  const url =
    `${EASTMONEY_FLOW_URL}` +
    `?secid=${secid}` +
    `&klt=101` +
    `&lmt=${days}` +
    `&fields1=f1,f2` +
    `&fields2=${fields2}`;

  const { res, text } = await fetchEastmoneyText(url, { secid, kind: 'flow', fields2 });

  if (!res.ok) {
    logEastmoneyError('fetchKlines HTTP error', {
      url,
      secid,
      days,
      fields2,
      status: res.status,
      statusText: res.statusText,
      bodyPreview: previewText(text),
    });
    throw new Error(
      `Eastmoney HTTP error: ${res.status} ${res.statusText} — ${previewText(text, 240)}`
    );
  }

  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (parseErr) {
    logEastmoneyError('fetchKlines JSON parse error', {
      url,
      fields2,
      message: parseErr?.message,
      bodyPreview: previewText(text),
    });
    throw new Error(
      `Eastmoney response is not valid JSON (${fields2}): ${parseErr?.message || parseErr}`
    );
  }

  if (!json?.data?.klines) {
    logEastmoneyError('fetchKlines invalid payload (missing data.klines)', {
      url,
      fields2,
      topKeys: json && typeof json === 'object' ? Object.keys(json) : [],
      dataKeys:
        json?.data && typeof json.data === 'object' ? Object.keys(json.data) : [],
      jsonPreview: previewText(JSON.stringify(json)),
    });
    throw new Error('Invalid Eastmoney response (missing data.klines)');
  }

  return json.data.klines.map((line) => {
    const parts = line.split(',');
    if (fields2 === 'f51') return parts[0];
    if (fields2.startsWith('f51,')) {
      return [
        parts[0],
        ...parts.slice(1).map((value) => Number(value)),
      ];
    }
    return parts.map(Number);
  });
}

async function fetchDailyMarketData(args) {
  const { secid, days } = args;
  const key = cacheKeyDaily(secid, days);
  return getOrFetchCached(key, () => fetchDailyMarketDataUncached(args));
}

async function fetchDailyMarketDataUncached({ secid, days }) {
  return fetchDailyMarketDataViaBrowser({ secid, days });
}

async function fetchDailyMarketDataViaUndici({ secid, days }) {
  const ut = encodeURIComponent(process.env.EASTMONEY_UT || EASTMONEY_DEFAULT_UT);
  const callback = `jsonp_kline_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const url =
    `${EASTMONEY_KLINE_URL}` +
    `?cb=${callback}` +
    `&secid=${secid}` +
    `&ut=${ut}` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101` +
    `&fqt=1` +
    `&beg=0` +
    `&end=20500101` +
    `&lmt=${Math.max(25, Number(days) || 25)}` +
    `&_=${Date.now()}`;

  const jsonpInit = {
    headers: {
      Accept: 'application/javascript, text/javascript, */*;q=0.1',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Dest': 'script',
    },
  };
  const { res, text } = await fetchEastmoneyText(
    url,
    { secid, kind: 'kline', forceHttp1: true },
    jsonpInit
  );

  if (!res.ok) {
    logEastmoneyError('fetchDailyMarketData HTTP error (returning empty)', {
      url,
      secid,
      days,
      status: res.status,
      statusText: res.statusText,
      bodyPreview: previewText(text),
    });
    return [];
  }

  const json = evaluateEastmoneyJsonp(text, callback);
  if (!json?.data?.klines || !Array.isArray(json.data.klines)) {
    logEastmoneyError('fetchDailyMarketData invalid JSONP payload (returning empty)', {
      url,
      topKeys: json && typeof json === 'object' ? Object.keys(json) : [],
      dataKeys:
        json?.data && typeof json.data === 'object' ? Object.keys(json.data) : [],
      jsonPreview: previewText(JSON.stringify(json)),
    });
    return [];
  }

  const klines = json.data.klines.slice(-days);
  return mapEastmoneyKlineRows(klines, 'eastmoney');
}

async function fetchDailyMarketDataViaBrowser({ secid, days }) {
  try {
    logEastmoneyError('fetchDailyMarketData falling back to browser JSONP', {
      secid,
      days,
    });
    return await fetchEastmoneyDailyKlinesViaBrowser(secid, days);
  } catch (err) {
    logEastmoneyError('fetchDailyMarketData browser fallback failed (returning empty)', {
      secid,
      days,
      name: err?.name,
      message: err?.message,
    });
    return [];
  }
}

function mapEastmoneyKlineRows(klines, source) {
  return klines.map((line) => {
    const parts = String(line).split(',');
    return {
      date: parts[0],
      open: Number(parts[1]),
      close: Number(parts[2]),
      high: Number(parts[3]),
      low: Number(parts[4]),
      volume: Number(parts[5]),
      total_amount: Number(parts[6]),
      amplitude: Number(parts[7]),
      change_pct: Number(parts[8]),
      change_amount: Number(parts[9]),
      turnover_rate: Number(parts[10]),
      source,
    };
  });
}

export async function fetchRealtimeQuote(code) {
  const secid = normalizeSecId(code);
  return fetchEastmoneyRealtimeQuoteViaBrowser(secid);
}

async function fetchEastmoneyText(url, context = {}, init) {
  const secid = secidFromEastmoneyUrl(url);
  const requestId = nextEastmoneyRequestId();
  const requestLabel = context.kind || 'fetch';
  const mergedInit = {
    ...init,
    headers: {
      ...eastmoneyDefaultHeaders(secid),
      ...(init?.headers && typeof init.headers === 'object' ? init.headers : {}),
    },
  };

  let lastErr;
  for (let attempt = 1; attempt <= EASTMONEY_FETCH_RETRIES; attempt++) {
    const startedAt = Date.now();
    try {
      const responseContext = await enqueueEastmoneyRequest(() =>
        eastmoneyHttpFetch(url, mergedInit, {
          requestId,
          secid,
          attempt,
          kind: requestLabel,
          url,
        })
      );
      const { res, selectedIp, tcpDialHost } = responseContext;
      const text = await res.text();
      logEastmoneyDebug('request success', {
        requestId,
        kind: requestLabel,
        secid,
        attempt,
        status: res.status,
        elapsedMs: Date.now() - startedAt,
        selectedIp,
        tcpDialHost,
        contentType: res.headers?.get?.('content-type') || '',
        bodySize: text.length,
      });
      const blockReason = detectEastmoneyBlockedPayload({
        url,
        status: res.status,
        headers: res.headers,
        text,
      });
      if (blockReason) {
        throw createEastmoneyLimitError(blockReason, {
          url,
          secid,
          requestId,
          status: res.status,
          selectedIp,
          tcpDialHost,
          bodyPreview: previewText(text, 240),
        });
      }

      noteEastmoneyFetchSuccess(secid, {
        selectedIp,
      });
      return { res, text };
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableEastmoneyNetworkError(err);
      if (retryable && attempt < EASTMONEY_FETCH_RETRIES) {
        noteEastmoneyFetchFailure(err, {
          secid,
          url,
          selectedIp: err?.detail?.selectedIp ?? null,
          usePush2hisIpPool: shouldUseEastmoneyPush2hisIpPool(url, context),
        });
        if (shouldResetEastmoneyAgent(err)) {
          await resetEastmoneyAgent(err, {
            secid,
            url,
            selectedIp: err?.detail?.selectedIp ?? null,
            usePush2hisIpPool: shouldUseEastmoneyPush2hisIpPool(url, context),
          });
        }
        const waitMs = backoffWithJitterMs(attempt);
        logEastmoneyError('fetch retry (transient network)', {
          requestId,
          kind: requestLabel,
          url,
          ...eastmoneyTcpDialLogFields(),
          attempt,
          maxAttempts: EASTMONEY_FETCH_RETRIES,
          waitMs,
          message: err?.message,
          causeCode: err?.cause?.code,
          causeMessage: err?.cause?.message,
          socket: summarizeEastmoneySocket(err?.cause?.socket),
        });
        await sleep(waitMs);
        continue;
      }
      logEastmoneyError('fetch network / queue error', {
        requestId,
        kind: requestLabel,
        url,
        ...eastmoneyTcpDialLogFields(),
        name: err?.name,
        message: err?.message,
        causeCode: err?.cause?.code,
        causeMessage: err?.cause?.message,
        socket: summarizeEastmoneySocket(err?.cause?.socket),
      });
      throw err;
    }
  }
  throw lastErr;
}

function noteEastmoneyFetchSuccess(secid, context = {}) {
  const selectedIp = context?.selectedIp ?? null;
  eastmoneyConsecutiveTransientFailures = 0;
  eastmoneyGlobalCooldownUntil = 0;
  eastmoneyDynamicDelayMs = Math.max(0, eastmoneyDynamicDelayMs - EASTMONEY_DYNAMIC_DELAY_STEP_MS);
  clearEastmoneyIpFailure(selectedIp);
}

function noteEastmoneyFetchFailure(err, context = {}) {
  const { secid, url, selectedIp, usePush2hisIpPool } = context;
  eastmoneyConsecutiveTransientFailures += 1;

  if (err?.code === 'EASTMONEY_RATE_LIMIT') {
    eastmoneyDynamicDelayMs = Math.min(
      EASTMONEY_DYNAMIC_DELAY_MAX_MS,
      eastmoneyDynamicDelayMs + EASTMONEY_DYNAMIC_DELAY_STEP_MS
    );
    eastmoneyGlobalCooldownUntil = Math.max(
      eastmoneyGlobalCooldownUntil,
      Date.now() + EASTMONEY_LIMIT_HIT_COOLDOWN_MS
    );
    logEastmoneyError('rate limit / block detected, enabling cooldown', {
      url,
      secid,
      reason: err.reason,
      status: err.status,
      cooldownUntil: new Date(eastmoneyGlobalCooldownUntil).toISOString(),
      cooldownMs: EASTMONEY_LIMIT_HIT_COOLDOWN_MS,
      dynamicDelayMs: eastmoneyDynamicDelayMs,
      ...eastmoneyTcpDialLogFields(),
    });
    return;
  }

  if (usePush2hisIpPool && selectedIp) {
    markEastmoneyIpFailure(selectedIp, err);
  }

  if (eastmoneyConsecutiveTransientFailures >= EASTMONEY_BLOCK_FAILURE_THRESHOLD) {
    eastmoneyGlobalCooldownUntil = Math.max(
      eastmoneyGlobalCooldownUntil,
      Date.now() + EASTMONEY_BLOCK_COOLDOWN_MS
    );
    logEastmoneyError('global cooldown enabled', {
      until: new Date(eastmoneyGlobalCooldownUntil).toISOString(),
      consecutiveFailures: eastmoneyConsecutiveTransientFailures,
      cooldownMs: EASTMONEY_BLOCK_COOLDOWN_MS,
      ...eastmoneyTcpDialLogFields(),
    });
  }
}

const CHROME_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
];

async function eastmoneyHttpFetch(url, init, context = {}) {
  const push2hisIpsConfigured = parseEastmoneyPush2hisIpsFromEnv().length > 0;
  const proxyConfig = getEastmoneyProxyConfig();
  const proxyUrl = proxyConfig.httpsProxy || proxyConfig.httpProxy;
  const secid = secidFromEastmoneyUrl(url);
  const shouldUsePush2hisIpPool = shouldUseEastmoneyPush2hisIpPool(url, context);
  const selectedIp =
    proxyUrl || !shouldUsePush2hisIpPool ? null : pickEastmoneyPush2hisIp(secid);

  if (process.env.EASTMONEY_DISABLE_UNDICI === '1') {
    if (push2hisIpsConfigured && !warnedPush2hisIpsWithoutUndici) {
      warnedPush2hisIpsWithoutUndici = true;
      console.warn(
        '[eastmoneyDailyFlow] EASTMONEY_PUSH2HIS_IPS is set but EASTMONEY_DISABLE_UNDICI=1; IP rotation is skipped (use undici).'
      );
    }
    if (proxyUrl && !warnedProxyWithoutUndici) {
      warnedProxyWithoutUndici = true;
      console.warn(
        '[eastmoneyDailyFlow] HTTP(S)_PROXY is set but EASTMONEY_DISABLE_UNDICI=1; proxy is not managed by this adapter fallback.'
      );
    }
    const res = await globalThis.fetch(url, init);
    return { res, selectedIp: null, tcpDialHost: null };
  }
  const undiciMod = await loadEastmoneyUndiciModule();
  if (!undiciMod?.fetch || !undiciMod.Agent) {
    if (push2hisIpsConfigured && !warnedPush2hisIpsWithoutUndici) {
      warnedPush2hisIpsWithoutUndici = true;
      console.warn(
        '[eastmoneyDailyFlow] EASTMONEY_PUSH2HIS_IPS is set but undici is unavailable; IP rotation is skipped.'
      );
    }
    if (proxyUrl && !warnedProxyWithoutUndici) {
      warnedProxyWithoutUndici = true;
      console.warn(
        '[eastmoneyDailyFlow] HTTP(S)_PROXY is set but undici is unavailable; proxy is not managed by this adapter fallback.'
      );
    }
    console.warn('Eastmoney: undici not found, using global fetch');
    const res = await globalThis.fetch(url, withEastmoneyRequestTimeout(init));
    return { res, selectedIp: null, tcpDialHost: null };
  }
  const desiredMode = proxyUrl ? 'proxy' : 'direct';
  if (!eastmoneyAgent || eastmoneyAgentMode !== desiredMode) {
    eastmoneyAgent = createEastmoneyDispatcher(undiciMod, {
      proxyConfig,
      proxyUrl,
    });
    eastmoneyAgentMode = desiredMode;
  }
  const dispatcher = getEastmoneyDispatcherForRequest(undiciMod, {
    proxyUrl,
    secid,
    selectedIp,
    forceHttp1: context?.forceHttp1,
  });
  logEastmoneyDebug('request dispatch', {
    requestId: context.requestId,
    kind: context.kind,
    secid,
    attempt: context.attempt,
    proxyUrl: proxyUrl || null,
    usePush2hisIpPool: shouldUsePush2hisIpPool,
    selectedIp,
    dispatcherType: dispatcher?.constructor?.name || typeof dispatcher,
    url,
  });
  try {
    const res = await undiciMod.fetch(url, {
      ...withEastmoneyRequestTimeout(init),
      dispatcher,
    });
    return {
      res,
      selectedIp,
      tcpDialHost: proxyUrl ? null : selectedIp,
    };
  } catch (err) {
    if (err && typeof err === 'object') {
      err.detail = {
        ...(err.detail && typeof err.detail === 'object' ? err.detail : {}),
        selectedIp,
        usePush2hisIpPool: shouldUsePush2hisIpPool,
      };
    }
    throw err;
  }
}

function createEastmoneyDispatcher(undiciMod, { proxyConfig, proxyUrl }) {
  const connections = Math.max(
    1,
    Number.parseInt(String(process.env.EASTMONEY_MAX_CONNECTIONS || '6'), 10) || 6
  );
  const allowH2 = eastmoneyAllowH2(Boolean(proxyUrl));
  const commonOpts = {
    allowH2,
    connections,
    pipelining: 1,
    keepAliveTimeout: EASTMONEY_KEEPALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: EASTMONEY_KEEPALIVE_MAX_TIMEOUT_MS,
  };

  const hasProxyAgent = typeof undiciMod.EnvHttpProxyAgent === 'function';
  if (proxyUrl && hasProxyAgent) {
    const dispatcher = new undiciMod.EnvHttpProxyAgent({
      ...commonOpts,
      httpProxy: proxyConfig.httpProxy || undefined,
      httpsProxy: proxyConfig.httpsProxy || undefined,
      noProxy: proxyConfig.noProxy || undefined,
    });
    if (!eastmoneyLoggedProxyConfig) {
      eastmoneyLoggedProxyConfig = true;
      console.error('[eastmoneyDailyFlow] proxy enabled via EnvHttpProxyAgent:', proxyUrl, {
        allowH2,
        connections,
        keepAliveTimeout: EASTMONEY_KEEPALIVE_TIMEOUT_MS,
      });
    }
    return dispatcher;
  }

  if (proxyUrl && typeof undiciMod.ProxyAgent === 'function') {
    const dispatcher = new undiciMod.ProxyAgent({
      uri: proxyUrl,
      ...commonOpts,
    });
    if (!eastmoneyLoggedProxyConfig) {
      eastmoneyLoggedProxyConfig = true;
      console.error('[eastmoneyDailyFlow] proxy enabled via ProxyAgent:', proxyUrl, {
        allowH2,
        connections,
        keepAliveTimeout: EASTMONEY_KEEPALIVE_TIMEOUT_MS,
      });
    }
    return dispatcher;
  }

  const dispatcher = new undiciMod.Agent(commonOpts);
  if (parseEastmoneyPush2hisIpsFromEnv().length > 0 && !eastmoneyLoggedPush2hisIpPool) {
    eastmoneyLoggedPush2hisIpPool = true;
    const pool = parseEastmoneyPush2hisIpsFromEnv();
    console.error(
      '[eastmoneyDailyFlow] push2his TCP pool:',
      pool.join(', '),
      '| request URL stays',
      `https://${EASTMONEY_PUSH2HIS_CANONICAL_HOST}/…`,
      '| secid is pinned to a stable IP while healthy'
    );
  }
  return dispatcher;
}

function getEastmoneyDispatcherForRequest(undiciMod, { proxyUrl, secid, selectedIp, forceHttp1 }) {
  if (proxyUrl) {
    return eastmoneyAgent;
  }
  if (forceHttp1) {
    if (!undiciMod?.Agent) return eastmoneyAgent;
    if (!eastmoneyScriptAgent) {
      eastmoneyScriptAgent = new undiciMod.Agent({
        allowH2: false,
        connections: 1,
        pipelining: 1,
        keepAliveTimeout: EASTMONEY_KEEPALIVE_TIMEOUT_MS,
        keepAliveMaxTimeout: EASTMONEY_KEEPALIVE_MAX_TIMEOUT_MS,
      });
    }
    return eastmoneyScriptAgent;
  }
  if (!selectedIp) {
    return eastmoneyAgent;
  }
  const ip = selectedIp;
  if (!ip) {
    return eastmoneyAgent;
  }
  if (!eastmoneyIpAgents.has(ip)) {
    const allowH2 = eastmoneyAllowH2(false);
    const dispatcher = new undiciMod.Agent({
      allowH2,
      connections: 1,
      pipelining: 1,
      keepAliveTimeout: EASTMONEY_KEEPALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: EASTMONEY_KEEPALIVE_MAX_TIMEOUT_MS,
      connect: createEastmoneyPush2hisConnector(undiciMod, ip),
    });
    eastmoneyIpAgents.set(ip, dispatcher);
  }
  eastmoneyLastTcpDialHost = ip;
  return eastmoneyIpAgents.get(ip) || eastmoneyAgent;
}

function secidFromEastmoneyUrl(url) {
  try {
    return new URL(url).searchParams.get('secid') || '';
  } catch {
    return '';
  }
}

function eastmoneyDefaultHeaders(secid) {
  const referer = process.env.EASTMONEY_REFERER || 'https://quote.eastmoney.com/';
  const headers = {
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: referer,
    'User-Agent': pickUserAgent(secid),
  };
  const cookie = process.env.EASTMONEY_COOKIE;
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

function pickUserAgent(secid) {
  if (process.env.EASTMONEY_USER_AGENT) {
    return process.env.EASTMONEY_USER_AGENT;
  }
  const strategy = (process.env.EASTMONEY_UA_STRATEGY || 'hash').toLowerCase();
  if (strategy === 'random') {
    return CHROME_USER_AGENTS[Math.floor(Math.random() * CHROME_USER_AGENTS.length)];
  }
  const idx = Math.abs(simpleHash32(secid || '')) % CHROME_USER_AGENTS.length;
  return CHROME_USER_AGENTS[idx];
}

function simpleHash32(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

function cacheKeyFlow(secid, days, fields2) {
  return `em:flow:${secid}:${days}:${fields2}`;
}

function cacheKeyDaily(secid, days) {
  return `em:daily:${secid}:${days}`;
}

async function getOrFetchCached(key, fetcher) {
  if (EASTMONEY_CACHE_TTL_MS <= 0) {
    return fetcher();
  }
  const now = Date.now();
  const hit = eastmoneyMemoryCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }
  if (eastmoneyInflight.has(key)) {
    return eastmoneyInflight.get(key);
  }
  const p = (async () => {
    try {
      const value = await fetcher();
      eastmoneyMemoryCache.set(key, { expiresAt: now + EASTMONEY_CACHE_TTL_MS, value });
      trimEastmoneyCache();
      return value;
    } finally {
      eastmoneyInflight.delete(key);
    }
  })();
  eastmoneyInflight.set(key, p);
  return p;
}

function trimEastmoneyCache() {
  while (eastmoneyMemoryCache.size > EASTMONEY_CACHE_MAX_ENTRIES) {
    const first = eastmoneyMemoryCache.keys().next().value;
    eastmoneyMemoryCache.delete(first);
  }
}

function isRetryableEastmoneyNetworkError(err) {
  if (!err) return false;
  if (err.code === 'EASTMONEY_RATE_LIMIT') return true;
  const code = err.cause?.code;
  const msg = String(err.message || '').toLowerCase();
  if (code === 'UND_ERR_SOCKET') return true;
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return true;
  if (code === 'UND_ERR_BODY_TIMEOUT') return true;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return true;
  if (code === 'EPIPE' || code === 'ECONNABORTED') return true;
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('timeout')) return true;
  if (msg.includes('socket') && msg.includes('closed')) return true;
  return false;
}

function shouldResetEastmoneyAgent(err) {
  if (err?.code === 'EASTMONEY_RATE_LIMIT') return true;
  const code = err?.cause?.code;
  if (!eastmoneyAgent) return false;
  return (
    code === 'UND_ERR_SOCKET' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED'
  );
}

async function resetEastmoneyAgent(err, context = {}) {
  const { selectedIp, usePush2hisIpPool } = context;
  const ip = usePush2hisIpPool ? selectedIp : null;
  if (!eastmoneyAgent && !ip) return;

  if (ip && eastmoneyIpAgents.has(ip)) {
    const ipAgent = eastmoneyIpAgents.get(ip);
    eastmoneyIpAgents.delete(ip);
    try {
      if (typeof ipAgent?.destroy === 'function') {
        await ipAgent.destroy(err);
      } else if (typeof ipAgent?.close === 'function') {
        await ipAgent.close();
      }
    } catch (destroyErr) {
      logEastmoneyError('ip agent reset failed', {
        ip,
        message: destroyErr?.message,
      });
    }
  }

  if (!eastmoneyAgent) return;
  const agent = eastmoneyAgent;
  eastmoneyAgent = null;
  eastmoneyAgentMode = null;
  try {
    if (typeof agent.destroy === 'function') {
      await agent.destroy(err);
      return;
    }
    if (typeof agent.close === 'function') {
      await agent.close();
    }
  } catch (destroyErr) {
    logEastmoneyError('agent reset failed', {
      message: destroyErr?.message,
      cause: destroyErr?.cause,
    });
  }
  if (eastmoneyScriptAgent) {
    try {
      if (typeof eastmoneyScriptAgent.destroy === 'function') {
        await eastmoneyScriptAgent.destroy(err);
      } else if (typeof eastmoneyScriptAgent.close === 'function') {
        await eastmoneyScriptAgent.close();
      }
    } catch (destroyErr) {
      logEastmoneyError('script agent reset failed', {
        message: destroyErr?.message,
      });
    }
    eastmoneyScriptAgent = null;
  }
}

function logEastmoneyError(label, detail) {
  console.error(`[eastmoneyDailyFlow] ${label}`, detail);
}

function logEastmoneyDebug(label, detail) {
  if (!EASTMONEY_DEBUG) {
    return;
  }
  console.error(`[eastmoneyDailyFlow] ${label}`, detail);
}

function summarizeEastmoneySocket(socket) {
  if (!socket || typeof socket !== 'object') {
    return undefined;
  }

  return {
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    localAddress: socket.localAddress,
    localPort: socket.localPort,
    bytesWritten: socket.bytesWritten,
    bytesRead: socket.bytesRead,
  };
}

function nextEastmoneyRequestId() {
  eastmoneyRequestSeq += 1;
  return `em-${Date.now()}-${eastmoneyRequestSeq}`;
}

function shouldUseEastmoneyPush2hisIpPool(url, context = {}) {
  if (parseEastmoneyPush2hisIpsFromEnv().length === 0) {
    return false;
  }
  const kind = String(context.kind || '').toLowerCase();
  if (kind === 'kline') {
    return false;
  }
  return url.includes('/api/qt/stock/fflow/kline/get');
}

function previewText(text, maxLen = 800) {
  const s = text == null ? '' : String(text);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}… (${s.length} chars total)`;
}

function evaluateEastmoneyJsonp(text, callbackName) {
  if (!callbackName) return null;
  const body = String(text || '').trim();
  if (!body) return null;

  let payload = null;
  const sandbox = {
    [callbackName]: (data) => {
      payload = data;
    },
  };
  try {
    const script = new vm.Script(body);
    script.runInNewContext(sandbox, { timeout: 1000 });
    return payload;
  } catch (err) {
    logEastmoneyError('evaluateEastmoneyJsonp failed', {
      callbackName,
      error: String(err),
      bodyPreview: previewText(body, 240),
    });
    return null;
  }
}

function backoffWithJitterMs(attempt) {
  const baseMs = 500 * attempt + eastmoneyDynamicDelayMs;
  const jitterMs = Math.floor(Math.random() * 250);
  return baseMs + jitterMs;
}

function withEastmoneyRequestTimeout(init) {
  const timeoutSignal = createEastmoneyTimeoutSignal(EASTMONEY_REQUEST_TIMEOUT_MS);
  if (!timeoutSignal) return init;

  return {
    ...init,
    signal: composeAbortSignals(init?.signal, timeoutSignal),
  };
}

function createEastmoneyTimeoutSignal(timeoutMs) {
  if (
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return AbortSignal.timeout(timeoutMs);
  }
  return null;
}

function composeAbortSignals(first, second) {
  if (!first) return second;
  if (!second) return first;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([first, second]);
  }

  const controller = new AbortController();
  const abort = (signal) => {
    if (controller.signal.aborted) return;
    controller.abort(signal?.reason);
  };

  if (first.aborted) {
    abort(first);
  } else {
    first.addEventListener('abort', () => abort(first), { once: true });
  }
  if (second.aborted) {
    abort(second);
  } else {
    second.addEventListener('abort', () => abort(second), { once: true });
  }
  return controller.signal;
}

function enqueueEastmoneyRequest(request) {
  const run = async () => {
    if (eastmoneyGlobalCooldownUntil > Date.now()) {
      await sleep(eastmoneyGlobalCooldownUntil - Date.now());
    }

    const waitMs = Math.max(
      0,
      nextEastmoneyRequestGapMs() + eastmoneyDynamicDelayMs - (Date.now() - lastEastmoneyRequestAt)
    );

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    lastEastmoneyRequestAt = Date.now();
    return request();
  };

  const queued = eastmoneyRequestQueue.then(run, run);
  eastmoneyRequestQueue = queued.then(
    () => undefined,
    () => undefined
  );

  return queued;
}

function nextEastmoneyRequestGapMs() {
  if (EASTMONEY_MAX_REQUEST_INTERVAL_MS <= EASTMONEY_MIN_REQUEST_INTERVAL_MS) {
    return EASTMONEY_MIN_REQUEST_INTERVAL_MS;
  }
  const span = EASTMONEY_MAX_REQUEST_INTERVAL_MS - EASTMONEY_MIN_REQUEST_INTERVAL_MS;
  return EASTMONEY_MIN_REQUEST_INTERVAL_MS + Math.floor(Math.random() * (span + 1));
}

function detectEastmoneyBlockedPayload({ status, headers, text }) {
  if (status === 403 || status === 429) {
    return `http_${status}`;
  }

  const contentType = String(headers?.get?.('content-type') || '').toLowerCase();
  const body = String(text || '').trim().toLowerCase();

  if (!body) return null;
  if (contentType.includes('text/html')) return 'html_payload';
  if (body.startsWith('<!doctype html') || body.startsWith('<html')) return 'html_payload';
  if (body.includes('访问过于频繁')) return 'too_frequent';
  if (body.includes('请稍后再试')) return 'retry_later';
  if (body.includes('验证码')) return 'captcha';
  if (body.includes('captcha')) return 'captcha';
  if (body.includes('forbidden')) return 'forbidden_page';
  if (body.includes('too many requests')) return 'too_many_requests';
  return null;
}

function createEastmoneyLimitError(reason, detail = {}) {
  const err = new Error(
    `Eastmoney rate limited or blocked (${reason})${detail?.status ? ` [${detail.status}]` : ''}`
  );
  err.code = 'EASTMONEY_RATE_LIMIT';
  err.reason = reason;
  err.status = detail?.status;
  err.detail = detail;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateBuyAmounts({ small, medium, large, extraLarge, totalAmount }) {
  const nets = {
    small: Number(small) || 0,
    medium: Number(medium) || 0,
    large: Number(large) || 0,
    extra_large: Number(extraLarge) || 0,
  };
  const absSum =
    Math.abs(nets.small) +
    Math.abs(nets.medium) +
    Math.abs(nets.large) +
    Math.abs(nets.extra_large);
  if (absSum <= 0) {
    return {
      small_buy: 0,
      medium_buy: 0,
      large_buy: 0,
      extra_large_buy: 0,
    };
  }

  const baseAmount = Number(totalAmount);
  const hasAmount = Number.isFinite(baseAmount) && baseAmount > 0;

  const smallTurnover = estimateTurnoverByNet(nets.small, absSum, baseAmount, hasAmount);
  const mediumTurnover = estimateTurnoverByNet(nets.medium, absSum, baseAmount, hasAmount);
  const largeTurnover = estimateTurnoverByNet(nets.large, absSum, baseAmount, hasAmount);
  const extraLargeTurnover = estimateTurnoverByNet(nets.extra_large, absSum, baseAmount, hasAmount);

  return {
    small_buy: Math.max(0, (smallTurnover + nets.small) / 2),
    medium_buy: Math.max(0, (mediumTurnover + nets.medium) / 2),
    large_buy: Math.max(0, (largeTurnover + nets.large) / 2),
    extra_large_buy: Math.max(0, (extraLargeTurnover + nets.extra_large) / 2),
  };
}

function estimateSellAmounts({ small, medium, large, extraLarge, totalAmount }) {
  const nets = {
    small: Number(small) || 0,
    medium: Number(medium) || 0,
    large: Number(large) || 0,
    extra_large: Number(extraLarge) || 0,
  };
  const absSum =
    Math.abs(nets.small) +
    Math.abs(nets.medium) +
    Math.abs(nets.large) +
    Math.abs(nets.extra_large);
  if (absSum <= 0) {
    return {
      small_sell: 0,
      medium_sell: 0,
      large_sell: 0,
      extra_large_sell: 0,
    };
  }

  const baseAmount = Number(totalAmount);
  const hasAmount = Number.isFinite(baseAmount) && baseAmount > 0;

  const smallTurnover = estimateTurnoverByNet(nets.small, absSum, baseAmount, hasAmount);
  const mediumTurnover = estimateTurnoverByNet(nets.medium, absSum, baseAmount, hasAmount);
  const largeTurnover = estimateTurnoverByNet(nets.large, absSum, baseAmount, hasAmount);
  const extraLargeTurnover = estimateTurnoverByNet(nets.extra_large, absSum, baseAmount, hasAmount);

  return {
    small_sell: Math.max(0, (smallTurnover - nets.small) / 2),
    medium_sell: Math.max(0, (mediumTurnover - nets.medium) / 2),
    large_sell: Math.max(0, (largeTurnover - nets.large) / 2),
    extra_large_sell: Math.max(0, (extraLargeTurnover - nets.extra_large) / 2),
  };
}

function estimateTurnoverByNet(netValue, absSum, totalAmount, hasAmount) {
  const absNet = Math.abs(netValue);
  if (!hasAmount) return absNet;
  const weighted = (totalAmount * absNet) / absSum;
  return Math.max(absNet, weighted);
}

function estimateTotalAmountFromNetFlows(row) {
  const values = [
    Number(row?.small),
    Number(row?.medium),
    Number(row?.large),
    Number(row?.extra_large),
  ].filter((value) => Number.isFinite(value));

  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + Math.abs(value), 0);
}

function normalizeSecId(code) {
  if (code.startsWith('6')) return `1.${code}`; // SH
  return `0.${code}`; // SZ
}

function toMillion(value) {
  return Number((value / 1_000_000).toFixed(3));
}

function toMillionOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return toMillion(n);
}
