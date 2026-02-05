import { Command } from 'commander';
import 'dotenv/config';
import { fetchDailyFundFlow, normalizeDailyFlow } from '../services/tushareDailyFlow.js';
import { storeDailyFundFlow, applyStockFilters, checkSmallNetBuyStreak } from '../services/storeDailyFlow.js';

export const rockCommand = new Command('rock')
  .argument('<start>', 'start stock code or range like 600030-600040')
  .argument('[end]', 'end stock code')
  .action(async (start, end) => {
    const codes = buildCodeRange(start, end);
    const matched = [];
    const errors = [];

    for (const code of codes) {
      try {
        const raw = await fetchDailyFundFlow(code);
        const daily = normalizeDailyFlow(raw);
        storeDailyFundFlow(code, daily);

        const check = applyStockFilters(code, [
          checkSmallNetBuyStreak(5),
        ]);
        if (check.passed) {
          matched.push(code);
        }
      } catch (err) {
        errors.push({ code, error: err?.message || String(err) });
      }
    }

    process.stdout.write(
      JSON.stringify(
        {
          status: 'ok',
          total: codes.length,
          matched_count: matched.length,
          matched_codes: matched
        },
        null,
        2
      )
    );

    if (errors.length > 0) {
      process.stderr.write(
        JSON.stringify(
          {
            status: 'error',
            errors
          },
          null,
          2
        )
      );
    }
  });

function buildCodeRange(start, end) {
  if (start.includes('-')) {
    const [left, right] = start.split('-');
    return expandRange(left, right);
  }
  if (end) {
    return expandRange(start, end);
  }
  return [start];
}

function expandRange(start, end) {
  const width = Math.max(start.length, end.length);
  const startInt = Number(start);
  const endInt = Number(end);
  if (!Number.isFinite(startInt) || !Number.isFinite(endInt)) {
    throw new Error('Invalid stock code range');
  }

  const low = Math.min(startInt, endInt);
  const high = Math.max(startInt, endInt);
  const codes = [];
  for (let i = low; i <= high; i++) {
    codes.push(String(i).padStart(width, '0'));
  }
  return codes;
}
