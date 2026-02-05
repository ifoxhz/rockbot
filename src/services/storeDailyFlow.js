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

export function checkSmallNetBuyStreak(code, minDays = 5) {
  const filePath = path.resolve('data/daily_fund_flow', `${code}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Daily fund flow data not found for code ${code}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const payload = JSON.parse(raw);
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  // Ensure ascending by date for streak calculation
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  let maxStreak = 0;
  let currentStreak = 0;
  let currentStart = null;
  let bestRange = null;

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    const isPositive = Number(row.small) > 0;
    const isConsecutiveTradingDay = i > 0; // adjacency in data = consecutive trading day

    if (isPositive) {
      if (currentStreak === 0) {
        currentStart = row.date;
        currentStreak = 1;
      } else if (isConsecutiveTradingDay) {
        currentStreak += 1;
      } else {
        currentStart = row.date;
        currentStreak = 1;
      }
    } else {
      currentStreak = 0;
      currentStart = null;
    }

    if (currentStreak > maxStreak) {
      maxStreak = currentStreak;
      bestRange = currentStreak > 0 ? { start: currentStart, end: row.date } : null;
    }
  }

  return {
    code,
    total_days: rows.length,
    min_days: minDays,
    max_streak: maxStreak,
    meets_requirement: maxStreak >= minDays,
    best_range: bestRange
  };
}
