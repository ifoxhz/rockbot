#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { fetch as undiciFetch } from 'undici';

const code = process.argv[2] || '600070';
const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
const marketCode = code.startsWith('6') ? `sh${code}` : `sz${code}`;
const ut = encodeURIComponent(process.env.EASTMONEY_UT || 'fa5fd1943c7b386f172d6893dbfba10b');
const timeoutMs = Math.max(
  1000,
  Number.parseInt(String(process.env.EASTMONEY_REQUEST_TIMEOUT_MS || '15000'), 10) || 15000
);

const hostCandidates = parseList(
  process.env.EASTMONEY_KLINE_PROBE_HOSTS ||
    'push2his.eastmoney.com,push2.eastmoney.com'
);

const refererCandidates = [
  'https://quote.eastmoney.com/',
  `https://quote.eastmoney.com/${marketCode}.html`,
];

const headerProfiles = [
  {
    id: 'basic',
    headers: {
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': defaultUserAgent(),
    },
  },
  {
    id: 'browserish',
    headers: {
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'User-Agent': defaultUserAgent(),
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    },
  },
];

for (const host of hostCandidates) {
  for (const referer of refererCandidates) {
    for (const profile of headerProfiles) {
      const result = await probeKline({ host, referer, profile });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
}

async function probeKline({ host, referer, profile }) {
  const startedAt = Date.now();
  const url =
    `https://${host}/api/qt/stock/kline/get` +
    `?secid=${secid}` +
    `&fields1=f1,f2,f3,f4,f5` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=1&beg=0&end=20500101` +
    `&ut=${ut}`;

  const headers = {
    ...profile.headers,
    Referer: referer,
  };

  if (process.env.EASTMONEY_COOKIE) {
    headers.Cookie = process.env.EASTMONEY_COOKIE;
  }

  try {
    const res = await undiciFetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return {
      ok: res.ok,
      host,
      referer,
      profile: profile.id,
      status: res.status,
      elapsedMs: Date.now() - startedAt,
      contentType: res.headers.get('content-type') || '',
      bodySize: text.length,
      bodyPreview: text.slice(0, 160),
    };
  } catch (err) {
    return {
      ok: false,
      host,
      referer,
      profile: profile.id,
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
  }
}

function parseList(raw) {
  return String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function defaultUserAgent() {
  return (
    process.env.EASTMONEY_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  );
}
