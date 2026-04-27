import { Command } from 'commander';
import { runHotrankPipeline } from '../services/hotrank/pipeline.js';
import { startHotrankServer } from '../app.js';

export const hotCommand = new Command('hot')
  .description('Run one hotrank data collection job')
  .option('-d, --date <date>', 'trade date (YYYY-MM-DD or YYYYMMDD)')
  .option('-m, --market <market>', 'market code used by tushare', 'A')
  .action(async (options) => {
    const tradeDate = normalizeDate(options.date);
    const result = await runHotrankPipeline({
      tradeDate,
      market: options.market,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'ok',
          command: 'hot',
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
        },
        null,
        2
      )}\n`
    );
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
