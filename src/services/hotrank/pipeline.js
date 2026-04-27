import { getConfig } from '../../config.js';
import { createSqliteClient, initHotrankSchema } from '../../db.js';
import { collectHotrankSnapshot } from './collector.js';
import { computeHotFeatures } from './feature.js';
import { runHotStrategies } from './strategy.js';
import * as tushareSource from './tushare.js';
import * as eastmoneySource from './eastmoney.js';

const HOTRANK_SOURCE_MAP = {
  tushare: tushareSource,
  eastmoney: eastmoneySource,
};

export async function runHotrankPipeline(options = {}) {
  const config = getConfig();
  const db = options.db || createSqliteClient(options.dbPath || config.hotrankDbPath);
  const debug = options.debug === true || process.env.HOTRANK_DEBUG === '1';
  const sourceName = normalizeSourceName(options.source || process.env.HOTRANK_SOURCE || 'tushare');
  const source = HOTRANK_SOURCE_MAP[sourceName];
  if (!source || typeof source.getHotRank !== 'function') {
    throw new Error(`Unsupported hotrank source: ${sourceName}`);
  }
  if (debug) {
    process.stdout.write(
      `[hotrank:pipeline] using db=${db.filePath} source=${sourceName} market=${options.market || config.hotrankMarket} tradeDate=${options.tradeDate || '(latest)'}\n`
    );
  }
  initHotrankSchema(db);

  const capture = await collectHotrankSnapshot({
    db,
    tradeDate: options.tradeDate,
    captureTime: options.captureTime,
    market: options.market || config.hotrankMarket,
    fetcher:
      options.fetcher ||
      ((fetchOptions) =>
        source.getHotRank({
          ...fetchOptions,
          backfillDays: options.backfillDays,
          backfillTop: options.backfillTop,
          debug,
        })),
    debug,
  });
  if (debug) {
    process.stdout.write(
      `[hotrank:pipeline] capture done inserted=${capture.inserted} total=${capture.total} tradeDate=${capture.tradeDate} captureTime=${capture.captureTime}\n`
    );
  }

  const features = computeHotFeatures({
    db,
    tradeDate: capture.tradeDate || options.tradeDate,
    calcTime: options.calcTime,
  });
  if (debug) {
    process.stdout.write(
      `[hotrank:pipeline] feature done inserted=${features.inserted} calcTime=${features.calcTime}\n`
    );
  }

  const strategy = runHotStrategies({
    db,
    tradeDate: capture.tradeDate || options.tradeDate,
    signalTime: options.signalTime,
    bigRisePct: options.bigRisePct,
  });
  if (debug) {
    process.stdout.write(
      `[hotrank:pipeline] strategy done inserted=${strategy.inserted} signalTime=${strategy.signalTime}\n`
    );
  }

  const tableCounts = readTableCounts(db);
  if (debug) {
    process.stdout.write(
      `[hotrank:pipeline] table counts snapshot=${tableCounts.hot_rank_snapshot} features=${tableCounts.hot_features} signals=${tableCounts.signals}\n`
    );
  }

  return {
    dbPath: db.filePath,
    capture,
    features,
    strategy,
    tableCounts,
    source: sourceName,
  };
}

function readTableCounts(db) {
  return {
    hot_rank_snapshot: countTable(db, 'hot_rank_snapshot'),
    hot_features: countTable(db, 'hot_features'),
    signals: countTable(db, 'signals'),
  };
}

function countTable(db, tableName) {
  const row = db.queryOne(`SELECT COUNT(*) AS cnt FROM ${tableName}`);
  const n = Number(row?.cnt);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSourceName(source) {
  return String(source || '').trim().toLowerCase();
}
