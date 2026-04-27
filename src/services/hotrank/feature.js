export function computeHotFeatures({ db, tradeDate, calcTime } = {}) {
  const runCalcTime = calcTime || new Date().toISOString();
  const targetDate = tradeDate || latestTradeDate(db);
  if (!targetDate) {
    return { calcTime: runCalcTime, tradeDate: null, inserted: 0 };
  }

  const latestCapture = db.queryOne(`
    SELECT capture_time
    FROM hot_rank_snapshot
    WHERE trade_date = ${db.quote(targetDate)}
    ORDER BY capture_time DESC
    LIMIT 1
  `);
  if (!latestCapture?.capture_time) {
    return { calcTime: runCalcTime, tradeDate: targetDate, inserted: 0 };
  }
  const captureTime = latestCapture.capture_time;

  const latestRows = db.queryAll(`
    SELECT stock_code, rank_no
    FROM hot_rank_snapshot
    WHERE trade_date = ${db.quote(targetDate)}
      AND capture_time = ${db.quote(captureTime)}
  `);

  const statements = [];
  for (const row of latestRows) {
    const stockCode = row.stock_code;
    const rankNow = toFinite(row.rank_no);
    const prev = db.queryOne(`
      SELECT rank_no
      FROM hot_rank_snapshot
      WHERE stock_code = ${db.quote(stockCode)}
        AND capture_time < ${db.quote(captureTime)}
      ORDER BY capture_time DESC
      LIMIT 1
    `);

    const scoreRows = db.queryAll(`
      SELECT score
      FROM hot_rank_snapshot
      WHERE stock_code = ${db.quote(stockCode)}
        AND score IS NOT NULL
      ORDER BY capture_time DESC
      LIMIT 7
    `).reverse();
    const scores = scoreRows
      .map((item) => toFinite(item.score))
      .filter((value) => Number.isFinite(value));

    const appear7d = db.queryOne(`
      SELECT COUNT(*) AS cnt
      FROM hot_rank_snapshot
      WHERE stock_code = ${db.quote(stockCode)}
        AND trade_date >= date(${db.quote(targetDate)}, '-6 day')
    `);
    const top10_30d = db.queryOne(`
      SELECT COUNT(*) AS cnt
      FROM hot_rank_snapshot
      WHERE stock_code = ${db.quote(stockCode)}
        AND rank_no <= 10
        AND trade_date >= date(${db.quote(targetDate)}, '-29 day')
    `);

    statements.push(`
      INSERT INTO hot_features (
        stock_code, calc_time, rank_now, rank_prev, heat_speed, appear_7d, top10_30d
      ) VALUES (
        ${db.quote(stockCode)},
        ${db.quote(runCalcTime)},
        ${db.quote(rankNow)},
        ${db.quote(toFinite(prev?.rank_no))},
        ${db.quote(toFinite(linearRegressionSlope(scores)))},
        ${db.quote(toFinite(appear7d?.cnt, 0))},
        ${db.quote(toFinite(top10_30d?.cnt, 0))}
      )
    `);
  }

  if (statements.length > 0) {
    db.transaction(statements);
  }
  return {
    calcTime: runCalcTime,
    tradeDate: targetDate,
    captureTime,
    inserted: statements.length,
  };
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

function linearRegressionSlope(values) {
  const n = Array.isArray(values) ? values.length : 0;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i += 1) {
    const y = Number(values[i]);
    if (!Number.isFinite(y)) return null;
    sumX += i;
    sumY += y;
    sumXX += i * i;
    sumXY += i * y;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  return Number(((n * sumXY - sumX * sumY) / denominator).toFixed(6));
}

function toFinite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
