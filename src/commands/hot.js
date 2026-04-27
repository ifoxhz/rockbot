import { Command } from 'commander';
import { runHotrankPipeline } from '../services/hotrank/pipeline.js';
import { startHotrankServer } from '../app.js';
import { getConfig } from '../config.js';
import { createSqliteClient, initHotrankSchema } from '../db.js';
import {
  buildHotrankTopTrendPayload,
  countHotrankDistinctTradeDates,
} from '../services/hotrank/topTrend.js';

export const hotCommand = new Command('hot')
  .description('Run one hotrank data collection job')
  .option('-d, --date <date>', 'trade date (YYYY-MM-DD or YYYYMMDD)')
  .option('-s, --source <source>', 'hotrank source: tushare|eastmoney', 'tushare')
  .option('-m, --market <market>', 'market code used by tushare', 'A')
  .option('--backfill-days <days>', 'when source=eastmoney, backfill N days history', '1')
  .option('--backfill-top <count>', 'when source=eastmoney, backfill top N symbols', '100')
  .option('--debug', 'print debug logs for hotrank pipeline', false)
  .action(async (options) => {
    const tradeDate = normalizeDate(options.date);
    const backfillDays = Math.max(1, Number.parseInt(String(options.backfillDays || '1'), 10) || 1);
    const backfillTop = Math.max(1, Number.parseInt(String(options.backfillTop || '100'), 10) || 100);
    process.stdout.write(
      `[hot] start tradeDate=${tradeDate || '(latest)'} source=${options.source} market=${options.market} backfill_days=${backfillDays} backfill_top=${backfillTop} debug=${options.debug ? 'on' : 'off'}\n`
    );
    try {
      const result = await runHotrankPipeline({
        tradeDate,
        source: options.source,
        market: options.market,
        backfillDays,
        backfillTop,
        debug: options.debug,
      });

      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'ok',
            command: 'hot',
            source: result.source,
            db_path: result.dbPath,
            capture: result.capture,
            features: {
              calcTime: result.features.calcTime,
              inserted: result.features.inserted,
            },
            signals: {
              signalTime: result.strategy.signalTime,
              inserted: result.strategy.inserted,
              rows: result.strategy.signals,
            },
            table_counts: result.tableCounts,
          },
          null,
          2
        )}\n`
      );
    } catch (err) {
      process.stderr.write(
        `${JSON.stringify(
          {
            status: 'error',
            command: 'hot',
            message: err?.message || String(err),
          },
          null,
          2
        )}\n`
      );
      process.exitCode = 1;
    }
  });

hotCommand
  .command('serve')
  .description('Start hotrank REST API server')
  .option('-p, --port <port>', 'port for API server')
  .action((options) => {
    startHotrankServer({
      port: Number(options.port),
    });
  });

hotCommand
  .command('rank-top')
  .description('Auto-fill and calculate top trend stocks')
  .option('-w, --window <days>', 'trend window days', '25')
  .option('-n, --limit <count>', 'top N stocks', '10')
  .option('-s, --source <source>', 'source for auto fill: eastmoney|tushare', 'eastmoney')
  .option('--backfill-top <count>', 'when source=eastmoney, backfill top N symbols', '100')
  .option('--debug', 'print debug logs', false)
  .action(async (options) => {
    const windowDays = toPositiveInt(options.window, 25);
    const limit = toPositiveInt(options.limit, 10);
    const backfillTop = toPositiveInt(options.backfillTop, 100);
    const source = String(options.source || 'eastmoney').trim().toLowerCase();
    const debug = options.debug === true;
    const config = getConfig();
    const db = createSqliteClient(config.hotrankDbPath);
    initHotrankSchema(db);

    const beforeDates = countHotrankDistinctTradeDates(db);
    const needAutofill = beforeDates < windowDays;
    let autofillResult = null;

    if (needAutofill) {
      process.stdout.write(
        `[hot rank-top] insufficient trade_dates=${beforeDates}, target=${windowDays}, start autofill via ${source}\n`
      );
      autofillResult = await runHotrankPipeline({
        source,
        market: 'A',
        backfillDays: windowDays,
        backfillTop,
        debug,
      });
    } else {
      process.stdout.write(
        `[hot rank-top] existing trade_dates=${beforeDates}, skip autofill\n`
      );
    }

    const payload = buildHotrankTopTrendPayload({
      db,
      windowDays,
      limit,
      debug,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'ok',
          command: 'hot rank-top',
          source,
          autofill: {
            triggered: needAutofill,
            before_distinct_trade_dates: beforeDates,
            after_distinct_trade_dates: countHotrankDistinctTradeDates(db),
            backfill_top: backfillTop,
            capture: autofillResult?.capture || null,
          },
          result: payload,
        },
        null,
        2
      )}\n`
    );
  });

function normalizeDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error('Invalid date format. Use YYYY-MM-DD or YYYYMMDD.');
}

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
