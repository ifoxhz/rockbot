#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { chromium } from 'playwright';

const code = process.argv[2] || '600070';
const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
const marketCode = code.startsWith('6') ? `sh${code}` : `sz${code}`;
const ut = encodeURIComponent(process.env.EASTMONEY_UT || 'fa5fd1943c7b386f172d6893dbfba10b');
const browserPath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  '/home/yong/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

const targetUrl =
  `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
  `?secid=${secid}` +
  `&fields1=f1,f2,f3,f4,f5` +
  `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
  `&klt=101&fqt=1&beg=0&end=20500101` +
  `&ut=${ut}`;

const bootstrapPageUrl = `https://quote.eastmoney.com/${marketCode}.html`;
const timeoutMs = Math.max(
  1000,
  Number.parseInt(String(process.env.EASTMONEY_REQUEST_TIMEOUT_MS || '15000'), 10) || 15000
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
  const bootstrapStartedAt = Date.now();
  let bootstrapResult;
  try {
    const resp = await page.goto(bootstrapPageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    bootstrapResult = {
      ok: true,
      status: resp?.status?.() ?? null,
      elapsedMs: Date.now() - bootstrapStartedAt,
      finalUrl: page.url(),
    };
  } catch (err) {
    bootstrapResult = {
      ok: false,
      elapsedMs: Date.now() - bootstrapStartedAt,
      name: err?.name,
      message: err?.message,
    };
  }

  const startedAt = Date.now();
  const result = await page.evaluate(async ({ url, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        credentials: 'include',
      });
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        bodySize: text.length,
        bodyPreview: text.slice(0, 160),
      };
    } catch (err) {
      return {
        ok: false,
        name: err?.name,
        message: err?.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }, { url: targetUrl, timeoutMs });

  process.stdout.write(
    `${JSON.stringify({
      code,
      bootstrapPageUrl,
      bootstrapResult,
      targetUrl,
      elapsedMs: Date.now() - startedAt,
      browserPath,
      result,
    })}\n`
  );
} finally {
  await browser.close();
}
