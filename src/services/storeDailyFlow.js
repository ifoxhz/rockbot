import fs from 'fs';
import path from 'path';

export function storeDailyFundFlow(code, dailyData) {
  const dir = path.resolve('data/daily_fund_flow');
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${code}.json`);

  const payload = {
    code,
    unit: 'million_cny',
    source: 'eastmoney',
    algorithm_version: 'daily_fund_flow_v1',
    generated_at: new Date().toISOString(),
    data: dailyData
  };

  fs.writeFileSync(
    filePath,
    JSON.stringify(payload, null, 2),
    'utf-8'
  );

  return filePath;
}

export function checkSmallNetBuyDays(code, minDays = 5) {
  const filePath = path.resolve('data/daily_fund_flow', `${code}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Daily fund flow data not found for code ${code}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const payload = JSON.parse(raw);
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  const positiveDates = rows
    .filter((row) => Number(row.small) > 0)
    .map((row) => row.date);

  return {
    code,
    total_days: rows.length,
    positive_days: positiveDates.length,
    min_days: minDays,
    meets_requirement: positiveDates.length >= minDays,
    positive_dates: positiveDates
  };
}

export function applyStockFilters(code, filters = []) {
  const rows = readDailyFundFlow(code);
  const ctx = { code, rows };

  const passed = Array.isArray(filters) && filters.length > 0
    ? filters.every((fn) => safeFilter(fn, ctx))
    : true;

  return {
    code,
    total_days: rows.length,
    passed
  };
}

// Hook / filter: returns a function that checks streak with row-level filters
export function checkSmallNetBuyStreak(minDays = 5, rowFilters = defaultRowFilters()) {
  return (ctx) => {
    const rows = Array.isArray(ctx?.rows) ? ctx.rows : [];
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

    let maxStreak = 0;
    let currentStreak = 0;

    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      const isConsecutiveTradingDay = i > 0; // adjacency in data = consecutive trading day
      const meetsAll = applyRowFilters(rowFilters, row);

      if (meetsAll) {
        if (currentStreak === 0) {
          currentStreak = 1;
        } else if (isConsecutiveTradingDay) {
          currentStreak += 1;
        } else {
          currentStreak = 1;
        }
      } else {
        currentStreak = 0;
      }

      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
      }
    }

    return maxStreak >= minDays;
  };
}

export function defaultRowFilters() {
  return [
    (row) => Number(row.small) > 0,
    (row) => row.change_pct != null && Number(row.change_pct) >= -1.8,
  ];
}

function readDailyFundFlow(code) {
  const filePath = path.resolve('data/daily_fund_flow', `${code}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Daily fund flow data not found for code ${code}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const payload = JSON.parse(raw);
  return Array.isArray(payload?.data) ? payload.data : [];
}

function applyRowFilters(filters, row) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  return filters.every((fn) => {
    try {
      return fn(row) === true;
    } catch {
      return false;
    }
  });
}

function safeFilter(fn, ctx) {
  try {
    return fn(ctx) === true;
  } catch {
    return false;
  }
}
