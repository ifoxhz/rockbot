import { Command } from 'commander';
import 'dotenv/config';
import * as eastmoneyFlow from '../services/eastmoneyDailyFlow.js';
import * as tushareFlow from '../services/tushareDailyFlow.js';
import * as xueqiuFlow from '../services/xueqiuDailyFlow.js';
import { storeDailyFundFlow, runStockAnalysis, storeDailyAnalysisFile, todayDate, getDefaultAnalysisConfig } from '../services/storeDailyFlow.js';
import { sendMatchedEmail, buildMatchedEmail } from '../services/email.js';

const DEFAULT_MIN_TURNOVER = getDefaultAnalysisConfig().minTurnover;
const DEFAULT_SOURCE = (process.env.ROCK_DATA_SOURCE || 'xueqiu').toLowerCase();
const DATA_SOURCE_MAP = {
  eastmoney: eastmoneyFlow,
  tushare: tushareFlow,
  xueqiu: xueqiuFlow,
};

export const rockCommand = new Command('rock')
  .argument('<start>', 'start stock code or range like 600030-600040')
  .argument('[end]', 'end stock code')
  .option('-s, --source <source>', 'data source: xueqiu|eastmoney|tushare', DEFAULT_SOURCE)
  .option('-m, --min-turnover <value>', 'minimum average turnover rate', String(DEFAULT_MIN_TURNOVER))
  .action(async (start, end, options) => {
    const source = normalizeDataSource(options.source);
    const adapter = DATA_SOURCE_MAP[source];
    if (!adapter) {
      throw new Error(`Invalid --source value: ${options.source}`);
    }

    const minTurnover = Number(options.minTurnover);
    if (!Number.isFinite(minTurnover)) {
      throw new Error('Invalid --min-turnover value');
    }

    const codes = buildCodeRange(start, end);
    const matched = [];
    const errors = [];
    const analysisResults = [];
    const downloadDate = todayDate();

    for (const code of codes) {
      try {
        const raw = await adapter.fetchDailyFundFlow(code);
        const daily = adapter.normalizeDailyFlow(raw);
        if (!Array.isArray(daily) || daily.length === 0) {
          // errors.push({ code, error: 'Empty daily fund flow data' });
          continue;
        }
        storeDailyFundFlow(code, daily, { date: downloadDate, source });

        const check = runStockAnalysis(code, {
          date: downloadDate,
          minTurnover,
        });
        const result = { code, ...check };
        if (check.passed) {
          matched.push(code);
        }
        analysisResults.push(result);
      } catch (err) {
        errors.push({ code, error: err?.message || String(err) });
      }

      // throttle between symbols to reduce upstream pressure
      await sleep(350);
    }

    storeDailyAnalysisFile(
      {
        source: 'download_run',
        data_source: source,
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
          download_date: downloadDate,
          min_turnover: minTurnover,
          data_source: source
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

function normalizeDataSource(source) {
  return String(source || '').trim().toLowerCase();
}
