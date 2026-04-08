import { setTimeout as sleep } from 'node:timers/promises';

const EASTMONEY_DEFAULT_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const PLAYWRIGHT_BROWSER_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  '/home/yong/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const EASTMONEY_BROWSER_TIMEOUT_MS = Math.max(
  2_000,
  Number.parseInt(String(process.env.EASTMONEY_BROWSER_TIMEOUT_MS || '15000'), 10) || 15_000
);
const EASTMONEY_BROWSER_ENABLED = process.env.EASTMONEY_BROWSER_ENABLED !== '0';

let playwrightModPromise = null;
let browserPromise = null;
let contextPromise = null;
let pagePromise = null;
let browserQueue = Promise.resolve();
let cleanupHookInstalled = false;
let idleCloseTimer = null;

function secidToMarketCode(secid) {
  const [market, code] = String(secid || '').split('.');
  if (!code) return '';
  return market === '1' ? `sh${code}` : `sz${code}`;
}

function eastmoneyBrowserHeaders() {
  return {
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
}

function eastmoneyBrowserUserAgent() {
  return (
    process.env.EASTMONEY_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  );
}

async function loadPlaywright() {
  if (!playwrightModPromise) {
    playwrightModPromise = import('playwright')
      .then((mod) => mod)
      .catch((err) => {
        playwrightModPromise = null;
        throw err;
      });
  }
  return playwrightModPromise;
}

async function getBrowser() {
  cancelIdleBrowserClose();
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await loadPlaywright();
      const browser = await chromium.launch({
        executablePath: PLAYWRIGHT_BROWSER_PATH,
        headless: true,
      });
      installCleanupHook();
      return browser;
    })().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function getContext() {
  cancelIdleBrowserClose();
  if (!contextPromise) {
    contextPromise = (async () => {
      const browser = await getBrowser();
      const context = await browser.newContext({
        userAgent: eastmoneyBrowserUserAgent(),
        extraHTTPHeaders: eastmoneyBrowserHeaders(),
      });
      return context;
    })().catch((err) => {
      contextPromise = null;
      throw err;
    });
  }
  return contextPromise;
}

async function getPage() {
  cancelIdleBrowserClose();
  if (!pagePromise) {
    pagePromise = (async () => {
      const context = await getContext();
      const page = await context.newPage();
      page.setDefaultTimeout(EASTMONEY_BROWSER_TIMEOUT_MS);
      return page;
    })().catch((err) => {
      pagePromise = null;
      throw err;
    });
  }
  return pagePromise;
}

function installCleanupHook() {
  if (cleanupHookInstalled) return;
  cleanupHookInstalled = true;
  const cleanup = async () => {
    await closeEastmoneyBrowser();
  };
  process.once('exit', () => {});
  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.once('SIGTERM', () => {
    void cleanup().finally(() => process.exit(143));
  });
}

async function withBrowserPage(task) {
  browserQueue = browserQueue.then(async () => {
    const page = await getPage();
    try {
      return await task(page);
    } finally {
      scheduleIdleBrowserClose();
    }
  });
  return browserQueue;
}

function scheduleIdleBrowserClose() {
  cancelIdleBrowserClose();
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    void closeEastmoneyBrowser();
  }, 1000);
  if (typeof idleCloseTimer?.unref === 'function') {
    idleCloseTimer.unref();
  }
}

function cancelIdleBrowserClose() {
  if (!idleCloseTimer) return;
  clearTimeout(idleCloseTimer);
  idleCloseTimer = null;
}

export async function closeEastmoneyBrowser() {
  cancelIdleBrowserClose();

  const page = await pagePromise?.catch?.(() => null);
  pagePromise = null;
  if (page && typeof page.close === 'function') {
    try {
      await page.close();
    } catch {}
  }

  const context = await contextPromise?.catch?.(() => null);
  contextPromise = null;
  if (context && typeof context.close === 'function') {
    try {
      await context.close();
    } catch {}
  }

  const browser = await browserPromise?.catch?.(() => null);
  browserPromise = null;
  if (browser && typeof browser.close === 'function') {
    try {
      await browser.close();
    } catch {}
  }
}

async function bootstrapQuotePage(page, secid) {
  const marketCode = secidToMarketCode(secid);
  if (!marketCode) {
    throw new Error(`Invalid secid for browser quote bootstrap: ${secid}`);
  }
  const url = `https://quote.eastmoney.com/${marketCode}.html`;
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(EASTMONEY_BROWSER_TIMEOUT_MS, 30_000),
    });
    await sleep(800);
  } catch (err) {
    if (err?.name !== 'TimeoutError') {
      throw err;
    }
    // Keep the partial navigation state and continue; some runs still acquire enough
    // cookies / anti-bot context before domcontentloaded completes.
    await sleep(1200);
  }
}

async function injectJsonp(page, buildUrl, callbackPrefix) {
  const callbackName = `${callbackPrefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const targetUrl =
    typeof buildUrl === 'function' ? buildUrl(callbackName) : String(buildUrl || '');
  const networkPromise = waitForScriptOutcome(page, targetUrl);
  const evalResult = await page.evaluate(
    ({ targetUrl, callbackName, timeoutMs }) =>
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
          resolve({ ok: false, mode: 'timeout' });
        }, timeoutMs);

        window[callbackName] = (payload) => {
          clearTimeout(timer);
          cleanup();
          resolve({ ok: true, mode: 'callback', payload });
        };

        const script = document.createElement('script');
        script.src = targetUrl;
        script.async = true;
        script.onerror = () => {
          clearTimeout(timer);
          cleanup();
          resolve({ ok: false, mode: 'script_error' });
        };
        document.head.appendChild(script);
      }),
    {
      targetUrl,
      callbackName,
      timeoutMs: EASTMONEY_BROWSER_TIMEOUT_MS,
    }
  );
  const networkResult = await networkPromise;
  return {
    ...evalResult,
    targetUrl,
    networkResult,
  };
}

export async function fetchEastmoneyRealtimeQuoteViaBrowser(secid) {
  if (!EASTMONEY_BROWSER_ENABLED) {
    throw new Error('EASTMONEY_BROWSER_ENABLED=0');
  }
  return withBrowserPage(async (page) => {
    await bootstrapQuotePage(page, secid);
    const fields = [
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
    const result = await injectJsonp(
      page,
      (callbackName) =>
        `https://push2.eastmoney.com/api/qt/stock/get` +
        `?invt=2` +
        `&fltt=1` +
        `&cb=${callbackName}` +
        `&fields=${encodeURIComponent(fields)}` +
        `&secid=${secid}` +
        `&ut=${encodeURIComponent(process.env.EASTMONEY_UT || EASTMONEY_DEFAULT_UT)}` +
        `&wbp2u=%7C0%7C0%7C0%7Cweb` +
        `&dect=1` +
        `&_=${Date.now()}`,
      'jsonp_quote'
    );
    if (!result?.ok || !result?.payload?.data) {
      throw new Error(`Eastmoney browser quote JSONP failed: ${result?.mode || 'unknown'}`);
    }
    const data = result.payload.data;
    return {
      latest_price: toFiniteOrNull(data.f43, 100),
      high: toFiniteOrNull(data.f44, 100),
      low: toFiniteOrNull(data.f45, 100),
      open: toFiniteOrNull(data.f46, 100),
      volume: toFiniteOrNull(data.f47),
      total_amount: toFiniteOrNull(data.f48),
      turnover_rate: toFiniteOrNull(data.f168, 100),
      change_amount: toFiniteOrNull(data.f169, 100),
      change_pct: toFiniteOrNull(data.f170, 100),
      source: 'eastmoney_browser_quote',
    };
  });
}

export async function fetchEastmoneyDailyKlinesViaBrowser(secid, days = 25) {
  if (!EASTMONEY_BROWSER_ENABLED) {
    throw new Error('EASTMONEY_BROWSER_ENABLED=0');
  }
  return withBrowserPage(async (page) => {
    await bootstrapQuotePage(page, secid);
    const result = await injectJsonp(
      page,
      (callbackName) =>
        `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
        `?cb=${callbackName}` +
        `&secid=${secid}` +
        `&ut=${encodeURIComponent(process.env.EASTMONEY_UT || EASTMONEY_DEFAULT_UT)}` +
        `&fields1=f1,f2,f3,f4,f5,f6` +
        `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
        `&klt=101` +
        `&fqt=1` +
        `&beg=0` +
        `&end=20500101` +
        `&lmt=${Math.max(25, Number(days) || 25)}` +
        `&_=${Date.now()}`,
      'jsonp_kline'
    );
    if (!result?.ok || !Array.isArray(result?.payload?.data?.klines)) {
      throw new Error(
        `Eastmoney browser kline JSONP failed: ${result?.mode || 'unknown'} (${JSON.stringify(result?.networkResult || null)})`
      );
    }
    const klines = result.payload.data.klines.slice(-days);
    return klines.map((line) => {
      const parts = String(line).split(',');
      return {
        date: parts[0],
        open: toFiniteOrNull(parts[1]),
        close: toFiniteOrNull(parts[2]),
        high: toFiniteOrNull(parts[3]),
        low: toFiniteOrNull(parts[4]),
        volume: toFiniteOrNull(parts[5]),
        total_amount: toFiniteOrNull(parts[6]),
        amplitude: toFiniteOrNull(parts[7]),
        change_pct: toFiniteOrNull(parts[8]),
        change_amount: toFiniteOrNull(parts[9]),
        turnover_rate: toFiniteOrNull(parts[10]),
        source: 'eastmoney_browser_kline',
      };
    });
  });
}

function toFiniteOrNull(value, divisor = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return divisor === 1 ? n : n / divisor;
}

function waitForScriptOutcome(page, targetUrl) {
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
    }, EASTMONEY_BROWSER_TIMEOUT_MS);

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
