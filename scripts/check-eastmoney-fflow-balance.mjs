#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { fetch as undiciFetch, Agent } from 'undici';

const code = process.argv[2] || '601179';
const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
const host = process.env.EASTMONEY_PUSH2HIS_HOST || 'push2his.eastmoney.com';
const ips = String(process.env.EASTMONEY_PUSH2HIS_IPS || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const ip = process.argv[3] || ips[0] || '';
const timeoutMs = Math.max(
  1000,
  Number.parseInt(String(process.env.EASTMONEY_REQUEST_TIMEOUT_MS || '15000'), 10) || 15000
);

const url =
  `https://${host}/api/qt/stock/fflow/kline/get` +
  `?secid=${secid}` +
  `&klt=101&lmt=25&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56`;

const headers = {
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: process.env.EASTMONEY_REFERER || 'https://quote.eastmoney.com/',
  'User-Agent':
    process.env.EASTMONEY_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
};
if (process.env.EASTMONEY_COOKIE) {
  headers.Cookie = process.env.EASTMONEY_COOKIE;
}

let dispatcher;
if (ip) {
  dispatcher = new Agent({
    connect: {
      servername: host,
      host: ip,
    },
    connections: 1,
    pipelining: 1,
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    allowH2: false,
  });
}

try {
  const res = await undiciFetch(url, {
    dispatcher,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const body = JSON.parse(text);
  const lines = Array.isArray(body?.data?.klines) ? body.data.klines : [];

  const rows = lines.map((line) => {
    const [date, f52, f53, f54, f55, f56] = String(line).split(',');
    const total = Number(f52);
    const sum = Number(f53) + Number(f54) + Number(f55) + Number(f56);
    const diff = sum - total;
    return {
      date,
      f52: total,
      sum_f53_f56: sum,
      diff,
    };
  });

  const absDiffs = rows.map((row) => Math.abs(row.diff)).filter(Number.isFinite);
  const maxAbsDiff = absDiffs.length ? Math.max(...absDiffs) : null;
  const avgAbsDiff = absDiffs.length
    ? absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length
    : null;

  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        secid,
        host,
        ip: ip || null,
        count: rows.length,
        maxAbsDiff,
        avgAbsDiff,
        rows,
      },
      null,
      2
    )}\n`
  );
} catch (err) {
  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        secid,
        host,
        ip: ip || null,
        name: err?.name,
        message: err?.message,
        causeCode: err?.cause?.code,
        causeMessage: err?.cause?.message,
        remoteAddress: err?.cause?.socket?.remoteAddress,
        remotePort: err?.cause?.socket?.remotePort,
        bytesWritten: err?.cause?.socket?.bytesWritten,
        bytesRead: err?.cause?.socket?.bytesRead,
      },
      null,
      2
    )}\n`
  );
} finally {
  if (dispatcher && typeof dispatcher.close === 'function') {
    await dispatcher.close();
  }
}
