import { getConfig } from '../../config.js';
import { createSqliteClient, initHotrankSchema } from '../../db.js';
import { collectHotrankSnapshot } from './collector.js';
import { computeHotFeatures } from './feature.js';
import { runHotStrategies } from './strategy.js';

export async function runHotrankPipeline(options = {}) {
  const config = getConfig();
  const db = options.db || createSqliteClient(options.dbPath || config.hotrankDbPath);
  initHotrankSchema(db);

  const capture = await collectHotrankSnapshot({
    db,
    tradeDate: options.tradeDate,
    captureTime: options.captureTime,
    market: options.market || config.hotrankMarket,
    fetcher: options.fetcher,
  });

  const features = computeHotFeatures({
    db,
    tradeDate: capture.tradeDate || options.tradeDate,
    calcTime: options.calcTime,
  });

  const strategy = runHotStrategies({
    db,
    tradeDate: capture.tradeDate || options.tradeDate,
    signalTime: options.signalTime,
    bigRisePct: options.bigRisePct,
  });

  return {
    dbPath: db.filePath,
    capture,
    features,
    strategy,
  };
}
