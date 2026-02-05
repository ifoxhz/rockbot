// src/services/eastmoneyDailyFlow.js

const EASTMONEY_FLOW_URL =
  'https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get';
const EASTMONEY_KLINE_URL =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get';

/**
 * Fetch raw daily fund flow data from Eastmoney
 * @param {string} code e.g. "600519"
 * @param {number} days default 30
 */
export async function fetchDailyFundFlow(code, days = 15) {
  const secid = normalizeSecId(code);

  // dates
  const dates = await fetchKlines({
    secid,
    days,
    fields2: 'f51',
  });

  // small / medium / large / extra large
  const flows = await fetchKlines({
    secid,
    days,
    fields2: 'f53,f54,f55,f56',
  });

  const pctRows = await fetchDailyPctChange({
    secid,
    days,
  });
  const pctMap = new Map(pctRows.map((row) => [row.date, row.change_pct]));

  if (dates.length !== flows.length) {
    throw new Error(
      `Eastmoney data length mismatch: dates=${dates.length}, flows=${flows.length}`
    );
  }

  return dates.map((date, i) => {
    const [small, medium, large, extraLarge] = flows[i];
    return {
      date,
      small,
      medium,
      large,
      extra_large: extraLarge,
      change_pct: pctMap.get(date) ?? null,
    };
  });
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
    unit: 'million',
    currency: 'CNY',
    source: 'eastmoney',
  }));
}

/* ---------------- helpers ---------------- */

async function fetchKlines({ secid, days, fields2 }) {
  const url =
    `${EASTMONEY_FLOW_URL}` +
    `?secid=${secid}` +
    `&klt=101` +
    `&lmt=${days}` +
    `&fields1=f1,f2` +
    `&fields2=${fields2}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Eastmoney HTTP error: ${res.status}`);
  }

  const json = await res.json();

  if (!json?.data?.klines) {
    throw new Error('Invalid Eastmoney response');
  }

  return json.data.klines.map((line) => {
    const parts = line.split(',');
    return fields2 === 'f51' ? parts[0] : parts.map(Number);
  });
}

async function fetchDailyPctChange({ secid, days }) {
  const url =
    `${EASTMONEY_KLINE_URL}` +
    `?secid=${secid}` +
    `&fields1=f1,f2,f3,f4,f5` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101` +
    `&fqt=1` +
    `&beg=0` +
    `&end=20500101` +
    `&ut=fa5fd1943c7b386f172d6893dbfba10b`;

  const res = await fetch(url);
  if (!res.ok) {
    return [];
  }

  const json = await res.json();

  if (!json?.data?.klines || !Array.isArray(json.data.klines)) {
    return [];
  }

  const klines = json.data.klines.slice(-days);

  return klines.map((line) => {
    const parts = line.split(',');
    return {
      date: parts[0],
      change_pct: Number(parts[8]),
    };
  });
}

function normalizeSecId(code) {
  if (code.startsWith('6')) return `1.${code}`; // SH
  return `0.${code}`; // SZ
}

function toMillion(value) {
  return Number((value / 1_000_000).toFixed(3));
}
