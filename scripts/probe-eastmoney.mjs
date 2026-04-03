#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { fetch as undiciFetch, Agent } from 'undici';

const code = process.argv[2] || '600070';
const rawIps = String(process.env.EASTMONEY_PUSH2HIS_IPS || '').trim();
const ipPool = rawIps
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
const ut = encodeURIComponent(process.env.EASTMONEY_UT || 'fa5fd1943c7b386f172d6893dbfba10b');
const host = process.env.EASTMONEY_PUSH2HIS_HOST || 'push2his.eastmoney.com';
const referer = process.env.EASTMONEY_REFERER || 'https://quote.eastmoney.com/';
const userAgent =
  process.env.EASTMONEY_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const timeoutMs = Math.max(
  1000,
  Number.parseInt(String(process.env.EASTMONEY_REQUEST_TIMEOUT_MS || '15000'), 10) || 15000
);

const urls = {
  flow:
    `https://${host}/api/qt/stock/fflow/kline/get` +
    `?secid=${secid}&klt=101&lmt=25&fields1=f1,f2&fields2=f53,f54,f55,f56`,
  kline:
    `https://${host}/api/qt/stock/kline/get` +
    `?secid=${secid}&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=0&end=20500101&ut=${ut}`,
};

const tests = [
  { mode: 'dns', kind: 'flow', url: urls.flow },
  { mode: 'dns', kind: 'kline', url: urls.kline },
];

if (ipPool.length > 0) {
  for (const ip of ipPool) {
    tests.push({ mode: 'ip', kind: 'flow', url: urls.flow, ip });
    tests.push({ mode: 'ip', kind: 'kline', url: urls.kline, ip });
  }
}

for (const test of tests) {
  const result = await runProbe(test);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runProbe(test) {
  const startedAt = Date.now();
  const headers = {
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: referer,
    'User-Agent': userAgent,
  };
  if (process.env.EASTMONEY_COOKIE) {
    headers.Cookie = process.env.EASTMONEY_COOKIE;
  }

  let dispatcher;
  if (test.mode === 'ip') {
    dispatcher = new Agent({
      connect: {
        servername: host,
        host: test.ip,
      },
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
      connections: 1,
      pipelining: 1,
      allowH2: false,
    });
  }

  try {
    const res = await undiciFetch(test.url, {
      dispatcher,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return {
      ok: res.ok,
      mode: test.mode,
      kind: test.kind,
      ip: test.ip || null,
      status: res.status,
      elapsedMs: Date.now() - startedAt,
      contentType: res.headers.get('content-type') || '',
      bodySize: text.length,
      bodyPreview: text.slice(0, 120),
    };
  } catch (err) {
    return {
      ok: false,
      mode: test.mode,
      kind: test.kind,
      ip: test.ip || null,
      elapsedMs: Date.now() - startedAt,
      name: err?.name,
      message: err?.message,
      causeCode: err?.cause?.code,
      causeMessage: err?.cause?.message,
      remoteAddress: err?.cause?.socket?.remoteAddress,
      remotePort: err?.cause?.socket?.remotePort,
      bytesWritten: err?.cause?.socket?.bytesWritten,
      bytesRead: err?.cause?.socket?.bytesRead,
    };
  } finally {
    if (dispatcher && typeof dispatcher.close === 'function') {
      await dispatcher.close();
    }
  }
}
