#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { fetch as undiciFetch, Agent } from 'undici';

const code = process.argv[2] || '601179';
const fields =
  process.argv[3] ||
  [
    'f43',
    'f44',
    'f45',
    'f46',
    'f47',
    'f48',
    'f57',
    'f58',
    'f59',
    'f60',
    'f107',
    'f152',
    'f168',
    'f169',
    'f170',
  ].join(',');

const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
const host = process.env.EASTMONEY_STOCK_GET_HOST || 'push2.eastmoney.com';
const timeoutMs = Math.max(
  1000,
  Number.parseInt(String(process.env.EASTMONEY_REQUEST_TIMEOUT_MS || '15000'), 10) || 15000
);
const callback = `jQuery_probe_${Date.now()}`;

const url =
  `https://${host}/api/qt/stock/get` +
  `?invt=2` +
  `&fltt=1` +
  `&cb=${callback}` +
  `&fields=${encodeURIComponent(fields)}` +
  `&secid=${secid}` +
  `&ut=${encodeURIComponent(process.env.EASTMONEY_UT || 'fa5fd1943c7b386f172d6893dbfba10b')}` +
  `&wbp2u=%7C0%7C0%7C0%7Cweb` +
  `&dect=1` +
  `&_=${Date.now()}`;

const headers = {
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer:
    process.env.EASTMONEY_REFERER ||
    `https://quote.eastmoney.com/${code.startsWith('6') ? 'sh' : 'sz'}${code}.html`,
  'User-Agent':
    process.env.EASTMONEY_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
};

if (process.env.EASTMONEY_COOKIE) {
  headers.Cookie = process.env.EASTMONEY_COOKIE;
}

let dispatcher = null;
const ip = (process.argv[4] || '').trim();
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
    dispatcher: dispatcher || undefined,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const json = parseJsonp(text);

  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        secid,
        host,
        ip: ip || null,
        url,
        fields: fields.split(','),
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        rc: json?.rc ?? null,
        rt: json?.rt ?? null,
        data: json?.data ?? null,
        rawTextPreview: text.slice(0, 500),
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
        url,
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

function parseJsonp(text) {
  const s = String(text || '').trim();
  const start = s.indexOf('(');
  const end = s.lastIndexOf(')');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(s.slice(start + 1, end));
  } catch {
    return null;
  }
}
