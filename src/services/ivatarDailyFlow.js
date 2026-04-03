// src/services/ivatarDailyFlow.js
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Fetch raw daily fund flow data from Ivatar.
 * Output shape is aligned with other adapters:
 * date/small/medium/large/extra_large + buy/sell + pct/turnover.
 *
 * Required env:
 * - IVATAR_DAILY_FLOW_URL: full HTTP endpoint
 *
 * Optional env:
 * - IVATAR_TOKEN
 * - IVATAR_TIMEOUT_MS
 */
export async function fetchDailyFundFlow(code, days = 25) {
  const endpoint = process.env.IVATAR_DAILY_FLOW_URL;
  if (!endpoint) {
    throw new Error('IVATAR_DAILY_FLOW_URL is required to fetch ivatar data');
  }

  const token = process.env.IVATAR_TOKEN;
  const timeoutMs = Number(process.env.IVATAR_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const marketCode = normalizeMarketCode(code);

  const json = await requestIvatar({
    endpoint,
    timeoutMs,
    token,
    payload: {
      code,
      symbol: code,
      market_code: marketCode,
      sec_code: code,
      days,
      count: days,
      period: 'day',
    },
  });

  const rows = extractRows(json);
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const mapped = rows.map((row) => {
    const smallBuy = pickNumber(row, [
      'small_buy',
      'buy_sm_amount',
      'sm_buy',
      'small_inflow',
      'small_buy_amount',
      'buy_small',
    ]);
    const smallSell = pickNumber(row, [
      'small_sell',
      'sell_sm_amount',
      'sm_sell',
      'small_outflow',
      'small_sell_amount',
      'sell_small',
    ]);
    const mediumBuy = pickNumber(row, [
      'medium_buy',
      'buy_md_amount',
      'md_buy',
      'medium_inflow',
      'medium_buy_amount',
      'buy_medium',
    ]);
    const mediumSell = pickNumber(row, [
      'medium_sell',
      'sell_md_amount',
      'md_sell',
      'medium_outflow',
      'medium_sell_amount',
      'sell_medium',
    ]);
    const largeBuy = pickNumber(row, [
      'large_buy',
      'buy_lg_amount',
      'lg_buy',
      'large_inflow',
      'large_buy_amount',
      'buy_large',
    ]);
    const largeSell = pickNumber(row, [
      'large_sell',
      'sell_lg_amount',
      'lg_sell',
      'large_outflow',
      'large_sell_amount',
      'sell_large',
    ]);
    const extraLargeBuy = pickNumber(row, [
      'extra_large_buy',
      'buy_elg_amount',
      'elg_buy',
      'super_buy',
      'super_inflow',
      'buy_super',
    ]);
    const extraLargeSell = pickNumber(row, [
      'extra_large_sell',
      'sell_elg_amount',
      'elg_sell',
      'super_sell',
      'super_outflow',
      'sell_super',
    ]);

    const smallNet = pickNetOrDiff(row, ['small', 'sm_net', 'small_net', 'small_net_amount'], smallBuy, smallSell);
    const mediumNet = pickNetOrDiff(row, ['medium', 'md_net', 'medium_net', 'medium_net_amount'], mediumBuy, mediumSell);
    const largeNet = pickNetOrDiff(row, ['large', 'lg_net', 'large_net', 'large_net_amount'], largeBuy, largeSell);
    const extraLargeNet = pickNetOrDiff(
      row,
      ['extra_large', 'elg_net', 'super_net', 'extra_large_net', 'super_net_amount'],
      extraLargeBuy,
      extraLargeSell
    );

    return {
      date: normalizeDate(
        pickString(row, ['date', 'trade_date', 'tradedate', 'day', 'kline_date', 'biz_date', 'dt'])
      ),
      small: smallNet,
      small_buy: smallBuy,
      small_sell: smallSell,
      medium: mediumNet,
      medium_buy: mediumBuy,
      medium_sell: mediumSell,
      large: largeNet,
      large_buy: largeBuy,
      large_sell: largeSell,
      extra_large: extraLargeNet,
      extra_large_buy: extraLargeBuy,
      extra_large_sell: extraLargeSell,
      change_pct: pickNumberOrNull(row, ['change_pct', 'pct_chg', 'percent', 'changePercent']),
      turnover_rate: pickNumberOrNull(row, ['turnover_rate', 'turnoverrate', 'turnover']),
    };
  });

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
    small_buy: toMillion(row.small_buy),
    small_sell: toMillion(row.small_sell),
    medium: toMillion(row.medium),
    medium_buy: toMillion(row.medium_buy),
    medium_sell: toMillion(row.medium_sell),
    large: toMillion(row.large),
    large_buy: toMillion(row.large_buy),
    large_sell: toMillion(row.large_sell),
    extra_large: toMillion(row.extra_large),
    extra_large_buy: toMillion(row.extra_large_buy),
    extra_large_sell: toMillion(row.extra_large_sell),
    change_pct: row.change_pct,
    turnover_rate: row.turnover_rate,
    unit: 'million',
    currency: 'CNY',
    source: 'ivatar',
  }));
}

/* ---------------- helpers ---------------- */

async function requestIvatar({ endpoint, timeoutMs, token, payload }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ivatar HTTP error: ${res.status}`);
    }

    const json = await res.json();
    if (json == null || typeof json !== 'object') {
      throw new Error('Invalid ivatar response');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function extractRows(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.rows)) return json.rows;
  if (Array.isArray(json.result)) return json.result;
  if (Array.isArray(json?.data?.rows)) return json.data.rows;
  if (Array.isArray(json?.data?.result)) return json.data.result;
  if (Array.isArray(json?.result?.rows)) return json.result.rows;
  return [];
}

function normalizeMarketCode(code) {
  if (String(code).startsWith('6')) return `SH${code}`;
  return `SZ${code}`;
}

function pickString(row, keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && row[key] !== '') {
      return String(row[key]);
    }
  }
  return '';
}

function pickNumber(row, keys) {
  for (const key of keys) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function pickNumberOrNull(row, keys) {
  for (const key of keys) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function pickNetOrDiff(row, netKeys, buyValue, sellValue) {
  for (const key of netKeys) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return (Number(buyValue) || 0) - (Number(sellValue) || 0);
}

function normalizeDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const ts = Number(text);
  if (Number.isFinite(ts) && ts > 0) {
    const ms = ts > 1_000_000_000_000 ? ts : ts * 1000;
    return formatDate(new Date(ms));
  }

  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) {
    return formatDate(d);
  }

  return text;
}

function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toMillion(value) {
  return Number(((Number(value) || 0) / 1_000_000).toFixed(3));
}
