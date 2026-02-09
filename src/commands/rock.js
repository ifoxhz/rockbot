import { Command } from 'commander';
import 'dotenv/config';
import { fetchDailyFundFlow, normalizeDailyFlow } from '../services/tushareDailyFlow.js';
import { storeDailyFundFlow, applyStockFilters, checkSmallNetBuyStreak, changePctStddev, risingDaysGreater, storeDailyAnalysisFile, todayDate } from '../services/storeDailyFlow.js';
import { sendMatchedEmail, buildMatchedEmail } from '../services/email.js';

export const rockCommand = new Command('rock')
  .argument('<start>', 'start stock code or range like 600030-600040')
  .argument('[end]', 'end stock code')
  .action(async (start, end) => {
    const codes = buildCodeRange(start, end);
    const matched = [];
    const errors = [];
    const analysisResults = [];
    const downloadDate = todayDate();

    for (const code of codes) {
      try {
        const raw = await fetchDailyFundFlow(code);
        const daily = normalizeDailyFlow(raw);
        if (!Array.isArray(daily) || daily.length === 0) {
          // errors.push({ code, error: 'Empty daily fund flow data' });
          continue;
        }
        storeDailyFundFlow(code, daily, { date: downloadDate });

        const check = applyStockFilters(code, [
          checkSmallNetBuyStreak(5),
          changePctStddev(1.62, 2.5),
          risingDaysGreater(),
        ], { date: downloadDate });
        const result = { code, ...check };
        if (check.passed) {
          matched.push(code);
        }
        analysisResults.push(result);
      } catch (err) {
        errors.push({ code, error: err?.message || String(err) });
      }

      // throttle to avoid Tushare rate limits
      await sleep(350);
    }

    storeDailyAnalysisFile(
      {
        source: 'download_run',
        total: codes.length,
        matched_count: matched.length,
        matched_codes: matched,
        results: analysisResults,
        errors
      },
      { date: downloadDate }
    );

    const matchedResults = analysisResults.filter((item) => item.passed === true);
    if (matchedResults.length > 0) {
      process.stdout.write('\nMatched results:\n');
      process.stdout.write(`${JSON.stringify(matchedResults, null, 2)}\n`);
    } else {
      process.stdout.write('\nMatched results: (none)\n');
    }

    try {
      const body = buildMatchedEmail({ date: downloadDate, matched: matchedResults });
      await sendMatchedEmail({
        from: 'onboarding@resend.dev',
        to: 'ifoxhz@hotmail.com',
        subject: `Rock matched results ${downloadDate}`,
        text: body
      });
    } catch (err) {
      errors.push({ code: 'email', error: err?.message || String(err) });
    }

    process.stdout.write(
      JSON.stringify(
        {
          status: 'ok',
          total: codes.length,
          matched_count: matched.length,
          matched_codes: matched,
          download_date: downloadDate
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
