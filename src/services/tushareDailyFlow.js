// src/services/tushareDailyFlow.js

const TUSHARE_API_URL = 'https://api.tushare.pro';
const RATE_LIMIT_PER_MIN = 200;
const RATE_WINDOW_MS = 60_000;

let windowStart = Date.now();
let requestCount = 0;

/**
 * Fetch raw daily fund flow data from Tushare (moneyflow + daily)
 * @param {string} code e.g. "600519"
 * @param {number} days default 15
 */
export async function fetchDailyFundFlow(code, days = 15) {
  const token = process.env.TUSHARE_TOKEN;
  if (!token) {
    throw new Error('TUSHARE_TOKEN is required to fetch Tushare data');
  }

  const ts_code = normalizeTsCode(code);
  const endDate = formatDate(new Date());
  const startDate = formatDate(addDays(new Date(), -days * 3));

  const moneyflowRows = await tushareRequest(token, 'moneyflow', {
    ts_code,
    start_date: startDate,
    end_date: endDate,
  }, [
    'trade_date',
    'buy_sm_amount',
    'sell_sm_amount',
    'buy_md_amount',
    'sell_md_amount',
    'buy_lg_amount',
    'sell_lg_amount',
    'buy_elg_amount',
    'sell_elg_amount',
  ]);

  const dailyRows = await tushareRequest(token, 'daily', {
    ts_code,
    start_date: startDate,
    end_date: endDate,
  }, [
    'trade_date',
    'pct_chg',
  ]);

  const dailyBasicRows = await tushareRequest(token, 'daily_basic', {
    ts_code,
    start_date: startDate,
    end_date: endDate,
  }, [
    'trade_date',
    'turnover_rate',
  ]);

  const pctMap = new Map(
    dailyRows.map((row) => [row.trade_date, row.pct_chg])
  );
  const turnoverMap = new Map(
    dailyBasicRows.map((row) => [row.trade_date, row.turnover_rate])
  );

  const mapped = moneyflowRows.map((row) => ({
    date: formatDateString(row.trade_date),
    small: toCnyNet(row.buy_sm_amount, row.sell_sm_amount),
    medium: toCnyNet(row.buy_md_amount, row.sell_md_amount),
    large: toCnyNet(row.buy_lg_amount, row.sell_lg_amount),
    extra_large: toCnyNet(row.buy_elg_amount, row.sell_elg_amount),
    change_pct: pctMap.has(row.trade_date) ? pctMap.get(row.trade_date) : null,
    turnover_rate: turnoverMap.has(row.trade_date) ? turnoverMap.get(row.trade_date) : null,
  }));

  mapped.sort((a, b) => a.date.localeCompare(b.date));
  return mapped.slice(-days);
}

/**
 * Normalize raw flow values:
 * - unit: million
 * - negative = sell dominant
 */
export function normalizeDailyFlow(rows) {
  return rows.map((row) => ({
    date: row.date,
    small: toMillion(row.small),
    medium: toMillion(row.medium),
    large: toMillion(row.large),
    extra_large: toMillion(row.extra_large),
    change_pct: row.change_pct,
    turnover_rate: row.turnover_rate,
    unit: 'million',
    currency: 'CNY',
    source: 'tushare',
  }));
}

/* ---------------- helpers ---------------- */

async function tushareRequest(token, apiName, params, fields) {
  await adaptiveThrottle();
  const res = await fetch(TUSHARE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_name: apiName,
      token,
      params,
      fields: Array.isArray(fields) ? fields.join(',') : fields,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tushare HTTP error: ${res.status}`);
  }

  const json = await res.json();
  if (json?.code !== 0 || !json?.data?.fields || !json?.data?.items) {
    const msg = json?.msg || 'Invalid Tushare response';
    throw new Error(msg);
  }

  const { fields: cols, items } = json.data;
  return items.map((item) => {
    const row = {};
    for (let i = 0; i < cols.length; i++) {
      row[cols[i]] = item[i];
    }
    return row;
  });
}

async function adaptiveThrottle() {
  const now = Date.now();
  if (now - windowStart >= RATE_WINDOW_MS) {
    windowStart = now;
    requestCount = 0;
  }

  requestCount += 1;

  const remaining = RATE_LIMIT_PER_MIN - requestCount;
  if (remaining <= 0) {
    const waitMs = RATE_WINDOW_MS - (now - windowStart) + 50;
    await sleep(waitMs);
    windowStart = Date.now();
    requestCount = 0;
    return;
  }

  // ramp up delay as we approach the limit
  const usedRatio = requestCount / RATE_LIMIT_PER_MIN;
  if (usedRatio > 0.7 && usedRatio <= 0.85) {
    await sleep(120);
  } else if (usedRatio > 0.85 && usedRatio <= 0.95) {
    await sleep(250);
  } else if (usedRatio > 0.95) {
    await sleep(500);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTsCode(code) {
  if (code.startsWith('6')) return `${code}.SH`;
  return `${code}.SZ`;
}

function toCnyNet(buyAmount, sellAmount) {
  const buy = Number(buyAmount) || 0;
  const sell = Number(sellAmount) || 0;
  // Tushare moneyflow uses 10k CNY (万元)
  return (buy - sell) * 10_000;
}

function toMillion(value) {
  return Number((value / 1_000_000).toFixed(3));
}

function addDays(date, deltaDays) {
  const d = new Date(date);
  d.setDate(d.getDate() + deltaDays);
  return d;
}

function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function formatDateString(yyyymmdd) {
  if (!yyyymmdd || String(yyyymmdd).length !== 8) return String(yyyymmdd);
  const s = String(yyyymmdd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
