// src/services/eastmoneyDailyFlow.js

const EASTMONEY_FLOW_URL =
  'https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get';

/**
 * Fetch raw daily fund flow data from Eastmoney
 * @param {string} code e.g. "600519"
 * @param {number} days default 30
 */
export async function fetchDailyFundFlow(code, days = 30) {
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

function normalizeSecId(code) {
  if (code.startsWith('6')) return `1.${code}`; // SH
  return `0.${code}`; // SZ
}

function toMillion(value) {
  return Number((value / 1_000_000).toFixed(3));
}
