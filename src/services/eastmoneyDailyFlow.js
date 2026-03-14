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

  const dailyRows = await fetchDailyMarketData({
    secid,
    days,
  });
  const dailyMap = new Map(dailyRows.map((row) => [row.date, row]));

  if (dates.length !== flows.length) {
    throw new Error(
      `Eastmoney data length mismatch: dates=${dates.length}, flows=${flows.length}`
    );
  }

  return dates.map((date, i) => {
    const [small, medium, large, extraLarge] = flows[i];
    const totalAmount = dailyMap.get(date)?.total_amount ?? null;
    const buy = estimateBuyAmounts({
      small,
      medium,
      large,
      extraLarge,
      totalAmount,
    });
    const sell = estimateSellAmounts({
      small,
      medium,
      large,
      extraLarge,
      totalAmount,
    });
    return {
      date,
      small,
      small_buy: buy.small_buy,
      small_sell: sell.small_sell,
      medium,
      medium_buy: buy.medium_buy,
      medium_sell: sell.medium_sell,
      large,
      large_buy: buy.large_buy,
      large_sell: sell.large_sell,
      extra_large: extraLarge,
      extra_large_buy: buy.extra_large_buy,
      extra_large_sell: sell.extra_large_sell,
      change_pct: dailyMap.get(date)?.change_pct ?? null,
      turnover_rate: dailyMap.get(date)?.turnover_rate ?? null,
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

async function fetchDailyMarketData({ secid, days }) {
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
      total_amount: Number(parts[6]),
      change_pct: Number(parts[8]),
      turnover_rate: Number(parts[10]),
    };
  });
}

function estimateBuyAmounts({ small, medium, large, extraLarge, totalAmount }) {
  const nets = {
    small: Number(small) || 0,
    medium: Number(medium) || 0,
    large: Number(large) || 0,
    extra_large: Number(extraLarge) || 0,
  };
  const absSum =
    Math.abs(nets.small) +
    Math.abs(nets.medium) +
    Math.abs(nets.large) +
    Math.abs(nets.extra_large);
  if (absSum <= 0) {
    return {
      small_buy: 0,
      medium_buy: 0,
      large_buy: 0,
      extra_large_buy: 0,
    };
  }

  const baseAmount = Number(totalAmount);
  const hasAmount = Number.isFinite(baseAmount) && baseAmount > 0;

  const smallTurnover = estimateTurnoverByNet(nets.small, absSum, baseAmount, hasAmount);
  const mediumTurnover = estimateTurnoverByNet(nets.medium, absSum, baseAmount, hasAmount);
  const largeTurnover = estimateTurnoverByNet(nets.large, absSum, baseAmount, hasAmount);
  const extraLargeTurnover = estimateTurnoverByNet(nets.extra_large, absSum, baseAmount, hasAmount);

  return {
    small_buy: Math.max(0, (smallTurnover + nets.small) / 2),
    medium_buy: Math.max(0, (mediumTurnover + nets.medium) / 2),
    large_buy: Math.max(0, (largeTurnover + nets.large) / 2),
    extra_large_buy: Math.max(0, (extraLargeTurnover + nets.extra_large) / 2),
  };
}

function estimateSellAmounts({ small, medium, large, extraLarge, totalAmount }) {
  const nets = {
    small: Number(small) || 0,
    medium: Number(medium) || 0,
    large: Number(large) || 0,
    extra_large: Number(extraLarge) || 0,
  };
  const absSum =
    Math.abs(nets.small) +
    Math.abs(nets.medium) +
    Math.abs(nets.large) +
    Math.abs(nets.extra_large);
  if (absSum <= 0) {
    return {
      small_sell: 0,
      medium_sell: 0,
      large_sell: 0,
      extra_large_sell: 0,
    };
  }

  const baseAmount = Number(totalAmount);
  const hasAmount = Number.isFinite(baseAmount) && baseAmount > 0;

  const smallTurnover = estimateTurnoverByNet(nets.small, absSum, baseAmount, hasAmount);
  const mediumTurnover = estimateTurnoverByNet(nets.medium, absSum, baseAmount, hasAmount);
  const largeTurnover = estimateTurnoverByNet(nets.large, absSum, baseAmount, hasAmount);
  const extraLargeTurnover = estimateTurnoverByNet(nets.extra_large, absSum, baseAmount, hasAmount);

  return {
    small_sell: Math.max(0, (smallTurnover - nets.small) / 2),
    medium_sell: Math.max(0, (mediumTurnover - nets.medium) / 2),
    large_sell: Math.max(0, (largeTurnover - nets.large) / 2),
    extra_large_sell: Math.max(0, (extraLargeTurnover - nets.extra_large) / 2),
  };
}

function estimateTurnoverByNet(netValue, absSum, totalAmount, hasAmount) {
  const absNet = Math.abs(netValue);
  if (!hasAmount) return absNet;
  const weighted = (totalAmount * absNet) / absSum;
  return Math.max(absNet, weighted);
}

function normalizeSecId(code) {
  if (code.startsWith('6')) return `1.${code}`; // SH
  return `0.${code}`; // SZ
}

function toMillion(value) {
  return Number((value / 1_000_000).toFixed(3));
}
