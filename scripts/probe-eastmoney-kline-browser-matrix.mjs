#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { chromium } from 'playwright';

const code = process.argv[2] || '601179';
const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
const marketCode = code.startsWith('6') ? `sh${code}` : `sz${code}`;
const ut = process.env.EASTMONEY_UT || 'fa5fd1943c7b386f172d6893dbfba10b';
const browserPath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  '/home/yong/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const timeoutMs = Math.max(
  2000,
  Number.parseInt(String(process.env.EASTMONEY_REQUEST_TIMEOUT_MS || '15000'), 10) || 15000
);

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
});

const variants = [
  {
    name: 'page_exact',
    query:
      `secid=${secid}` +
      `&ut=${encodeURIComponent(ut)}` +
      `&fields1=f1,f2,f3,f4,f5,f6` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
      `&klt=101&fqt=1&beg=0&end=20500101&smplmt=460&lmt=1000000`,
  },
  {
    name: 'bounded_25',
    query:
      `secid=${secid}` +
      `&ut=${encodeURIComponent(ut)}` +
      `&fields1=f1,f2,f3,f4,f5,f6` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
      `&klt=101&fqt=1&beg=0&end=20500101&lmt=25`,
  },
  {
    name: 'bounded_60_recent',
    query:
      `secid=${secid}` +
      `&ut=${encodeURIComponent(ut)}` +
      `&fields1=f1,f2,f3,f4,f5,f6` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
      `&klt=101&fqt=1&beg=20250101&end=20500101&lmt=60`,
  },
  {
    name: 'minimal_no_lmt',
    query:
      `secid=${secid}` +
      `&ut=${encodeURIComponent(ut)}` +
      `&fields1=f1,f2,f3,f4,f5,f6` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
      `&klt=101&fqt=1&beg=0&end=20500101`,
  },
];

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

  const bootstrapPageUrl = `https://quote.eastmoney.com/${marketCode}.html`;
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

  const results = [];
  for (const variant of variants) {
    const startedAt = Date.now();
    const callback = `jsonp_${variant.name}_${Date.now()}`;
    const targetUrl =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?cb=${callback}&${variant.query}&_=${Date.now()}`;

    const eventPromise = waitForScriptOutcome(page, targetUrl, timeoutMs);
    const evalResult = await page.evaluate(
      ({ url, callbackName, timeoutMs }) =>
        new Promise((resolve) => {
          const cleanup = () => {
            try {
              delete window[callbackName];
            } catch {}
            if (script.parentNode) {
              script.parentNode.removeChild(script);
            }
          };

          const timer = setTimeout(() => {
            cleanup();
            resolve({ mode: 'timeout' });
          }, timeoutMs);

          window[callbackName] = (payload) => {
            clearTimeout(timer);
            cleanup();
            resolve({
              mode: 'callback',
              rc: payload?.rc ?? null,
              hasData: Boolean(payload?.data),
              dataKeys:
                payload?.data && typeof payload.data === 'object' ? Object.keys(payload.data) : [],
              klineCount: Array.isArray(payload?.data?.klines) ? payload.data.klines.length : 0,
            });
          };

          const script = document.createElement('script');
          script.src = url;
          script.async = true;
          script.onerror = () => {
            clearTimeout(timer);
            cleanup();
            resolve({ mode: 'script_error' });
          };
          document.head.appendChild(script);
        }),
      { url: targetUrl, callbackName: callback, timeoutMs }
    );
    const networkResult = await eventPromise;

    results.push({
      name: variant.name,
      url: targetUrl,
      elapsedMs: Date.now() - startedAt,
      evalResult,
      networkResult,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        secid,
        browserPath,
        bootstrapPageUrl,
        bootstrapResult,
        results,
      },
      null,
      2
    )}\n`
  );
} finally {
  await browser.close();
}

function waitForScriptOutcome(page, targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    const normalized = stripCacheBust(targetUrl);

    const onResponse = async (res) => {
      if (stripCacheBust(res.url()) !== normalized) return;
      cleanup();
      let bodyPreview = '';
      try {
        const text = await res.text();
        bodyPreview = text.slice(0, 240);
      } catch {}
      resolve({
        type: 'response',
        status: res.status(),
        contentType: res.headers()['content-type'] || '',
        bodyPreview,
      });
    };

    const onFailed = (req) => {
      if (stripCacheBust(req.url()) !== normalized) return;
      cleanup();
      resolve({
        type: 'requestfailed',
        failure: req.failure(),
      });
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({ type: 'timeout' });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
    }

    page.on('response', onResponse);
    page.on('requestfailed', onFailed);
  });
}

function stripCacheBust(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('_');
    u.searchParams.delete('cb');
    return u.toString();
  } catch {
    return url;
  }
}
