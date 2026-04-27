import { getConfig } from '../../config.js';

export function runHotStrategies({ db, tradeDate, signalTime, bigRisePct } = {}) {
  const config = getConfig();
  const runSignalTime = signalTime || new Date().toISOString();
  const targetDate = tradeDate || latestTradeDate(db);
  if (!targetDate) {
    return { signalTime: runSignalTime, tradeDate: null, inserted: 0, signals: [] };
  }

  const latestCalc = db.queryOne(`
    SELECT calc_time
    FROM hot_features
    ORDER BY calc_time DESC
    LIMIT 1
  `);
  if (!latestCalc?.calc_time) {
    return { signalTime: runSignalTime, tradeDate: targetDate, inserted: 0, signals: [] };
  }

  const threshold = Number.isFinite(Number(bigRisePct)) ? Number(bigRisePct) : config.hotrankBigRisePct;
  const rows = db.queryAll(`
    SELECT
      f.stock_code,
      f.rank_now,
      f.rank_prev,
      f.heat_speed,
      f.appear_7d,
      f.top10_30d,
      s.stock_name
    FROM hot_features f
    LEFT JOIN hot_rank_snapshot s
      ON s.stock_code = f.stock_code
    WHERE f.calc_time = ${db.quote(latestCalc.calc_time)}
      AND s.trade_date = ${db.quote(targetDate)}
    GROUP BY f.stock_code
  `);

  const signals = [];
  for (const row of rows) {
    const stockCode = row.stock_code;
    const stockName = row.stock_name || '';
    const rankNow = toFinite(row.rank_now);
    const rankPrev = toFinite(row.rank_prev);
    const heatSpeed = toFinite(row.heat_speed, 0);
    const appear7d = toFinite(row.appear_7d, 0);
    const top10_30d = toFinite(row.top10_30d, 0);
    const improving = hasThreeConsecutiveRankImprovements(db, stockCode);
    const maxRise20d = maxPctChgLastDays(db, stockCode, targetDate, 20);

    const reasons = [];
    if (rankNow <= 30 && (rankPrev === null || rankPrev > 30)) {
      reasons.push('今日进入前30');
    }
    if (improving) {
      reasons.push('连续3次排名提升');
    }
    if (maxRise20d < threshold) {
      reasons.push('最近20日未大涨');
    }

    if (reasons.length === 3) {
      const score = Number((40 - rankNow + heatSpeed * 10 + appear7d * 0.5).toFixed(3));
      signals.push({
        ts_code: stockCode,
        stock_name: stockName,
        signal_type: 'BUY_WATCH',
        score,
        reason: reasons.join('；'),
      });
    }

    if (rankNow <= 10 && top10_30d >= 10 && maxRise20d >= threshold) {
      signals.push({
        ts_code: stockCode,
        stock_name: stockName,
        signal_type: 'OVERHEAT',
        score: Number((top10_30d + Math.max(0, heatSpeed) * 10).toFixed(3)),
        reason: '高位热度持续且近期涨幅较大',
      });
    }
  }

  if (signals.length > 0) {
    const statements = signals.map((signal) => `
      INSERT INTO signals (
        signal_time, ts_code, stock_name, signal_type, score, reason
      ) VALUES (
        ${db.quote(runSignalTime)},
        ${db.quote(signal.ts_code)},
        ${db.quote(signal.stock_name)},
        ${db.quote(signal.signal_type)},
        ${db.quote(signal.score)},
        ${db.quote(signal.reason)}
      )
    `);
    db.transaction(statements);
  }

  return {
    signalTime: runSignalTime,
    tradeDate: targetDate,
    inserted: signals.length,
    signals,
  };
}

function hasThreeConsecutiveRankImprovements(db, stockCode) {
  const rows = db.queryAll(`
    SELECT rank_no
    FROM hot_rank_snapshot
    WHERE stock_code = ${db.quote(stockCode)}
      AND rank_no IS NOT NULL
    ORDER BY capture_time DESC
    LIMIT 3
  `).reverse();
  if (rows.length < 3) return false;
  const [a, b, c] = rows.map((row) => toFinite(row.rank_no));
  if (![a, b, c].every((value) => Number.isFinite(value))) return false;
  return a > b && b > c;
}

function maxPctChgLastDays(db, stockCode, tradeDate, days) {
  const row = db.queryOne(`
    SELECT MAX(pct_chg) AS max_pct_chg
    FROM hot_rank_snapshot
    WHERE stock_code = ${db.quote(stockCode)}
      AND trade_date >= date(${db.quote(tradeDate)}, ${db.quote(`-${days - 1} day`)})
  `);
  return toFinite(row?.max_pct_chg, Number.NEGATIVE_INFINITY);
}

function latestTradeDate(db) {
  const row = db.queryOne(`
    SELECT trade_date
    FROM hot_rank_snapshot
    ORDER BY trade_date DESC
    LIMIT 1
  `);
  return row?.trade_date || null;
}

function toFinite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
