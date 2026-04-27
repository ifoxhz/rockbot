import { Command } from 'commander';
import { runHotrankPipeline } from '../services/hotrank/pipeline.js';
import { startHotrankServer } from '../app.js';

export const hotCommand = new Command('hot')
  .description('Run one hotrank data collection job')
  .option('-d, --date <date>', 'trade date (YYYY-MM-DD or YYYYMMDD)')
  .option('-s, --source <source>', 'hotrank source: tushare|eastmoney', 'tushare')
  .option('-m, --market <market>', 'market code used by tushare', 'A')
  .option('--debug', 'print debug logs for hotrank pipeline', false)
  .action(async (options) => {
    const tradeDate = normalizeDate(options.date);
    process.stdout.write(
      `[hot] start tradeDate=${tradeDate || '(latest)'} source=${options.source} market=${options.market} debug=${options.debug ? 'on' : 'off'}\n`
    );
    try {
      const result = await runHotrankPipeline({
        tradeDate,
        source: options.source,
        market: options.market,
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

function normalizeDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error('Invalid date format. Use YYYY-MM-DD or YYYYMMDD.');
}
