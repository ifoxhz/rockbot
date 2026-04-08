#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { chromium } from 'playwright';

const code = process.argv[2] || '601179';
const marketCode = code.startsWith('6') ? `sh${code}` : `sz${code}`;
const pageMode = (process.argv[3] || process.env.EASTMONEY_PAGE_MODE || 'legacy').trim();
const pageUrl = resolvePageUrl(code, marketCode, pageMode);
const browserPath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  '/home/yong/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const captureMs = Math.max(
  3000,
  Number.parseInt(String(process.env.EASTMONEY_CAPTURE_MS || '12000'), 10) || 12000
);
const maxEvents = Math.max(
  20,
  Number.parseInt(String(process.env.EASTMONEY_CAPTURE_MAX_EVENTS || '200'), 10) || 200
);

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
});

try {
  const context = await browser.newContext({
    userAgent:
      process.env.EASTMONEY_USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  const page = await context.newPage();
  const events = [];
  const startedAt = Date.now();

  page.on('request', (req) => {
    if (events.length >= maxEvents) return;
    const url = req.url();
    if (!isInteresting(url)) return;
    events.push({
      t: Date.now() - startedAt,
      type: 'request',
      method: req.method(),
      resourceType: req.resourceType(),
      url,
      headers: pickHeaders(req.headers()),
    });
  });

  page.on('response', async (res) => {
    if (events.length >= maxEvents) return;
    const url = res.url();
    if (!isInteresting(url)) return;
    const headers = res.headers();
    let bodyPreview = '';
    try {
      const text = await res.text();
      bodyPreview = text.slice(0, 240);
    } catch {
      bodyPreview = '';
    }
    events.push({
      t: Date.now() - startedAt,
      type: 'response',
      status: res.status(),
      url,
      contentType: headers['content-type'] || '',
      bodyPreview,
    });
  });

  page.on('requestfailed', (req) => {
    if (events.length >= maxEvents) return;
    const url = req.url();
    if (!isInteresting(url)) return;
    events.push({
      t: Date.now() - startedAt,
      type: 'requestfailed',
      method: req.method(),
      resourceType: req.resourceType(),
      url,
      failure: req.failure(),
    });
  });

  const nav = await page.goto(pageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: captureMs,
  });

  await page.waitForTimeout(captureMs);

  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        pageUrl,
        browserPath,
        navigation: {
          ok: Boolean(nav),
          status: nav?.status?.() ?? null,
          finalUrl: page.url(),
        },
        pageMode,
        totalCaptured: events.length,
        events,
      },
      null,
      2
    )}\n`
  );
} finally {
  await browser.close();
}

function isInteresting(url) {
  return (
    url.includes('eastmoney.com') ||
    url.includes('emchart.eastmoney.com') ||
    url.includes('/api/qt/') ||
    url.includes('push2') ||
    url.includes('push2his')
  );
}

function pickHeaders(headers) {
  const out = {};
  for (const key of ['referer', 'origin', 'accept', 'cookie', 'user-agent', 'sec-fetch-site']) {
    if (headers[key]) out[key] = headers[key];
  }
  return out;
}

function resolvePageUrl(code, marketCode, pageMode) {
  if (/^https?:\/\//i.test(pageMode)) {
    return pageMode;
  }

  if (pageMode === 'unify') {
    const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
    return `https://quote.eastmoney.com/unify/cr/${secid}`;
  }

  return `https://quote.eastmoney.com/${marketCode}.html`;
}
