export function buildHotrankTopTrendPayload({ db, windowDays = 25, limit = 10, debug = false }) {
  const safeWindowDays = Math.max(1, Number(windowDays) || 25);
  const safeLimit = Math.max(1, Number(limit) || 10);

  const totalSnapshotRows = Number(
    db.queryOne(`SELECT COUNT(*) AS cnt FROM hot_rank_snapshot`)?.cnt || 0
  );
  const totalDistinctDates = Number(
    db.queryOne(`SELECT COUNT(DISTINCT trade_date) AS cnt FROM hot_rank_snapshot`)?.cnt || 0
  );

  const dateRows = db.queryAll(`
    SELECT DISTINCT trade_date
    FROM hot_rank_snapshot
    ORDER BY trade_date DESC
    LIMIT ${safeWindowDays}
  `);
  const selectedDatesDesc = dateRows.map((row) => String(row.trade_date || '')).filter(Boolean);
  const selectedDates = [...selectedDatesDesc].reverse();
  if (selectedDates.length === 0) {
    const emptyPayload = {
      window_days: safeWindowDays,
      limit: safeLimit,
      dates: [],
      rows: [],
      diagnostics: {
        total_snapshot_rows: totalSnapshotRows,
        total_distinct_trade_dates: totalDistinctDates,
        selected_trade_dates: 0,
        candidate_stocks: 0,
        regressable_stocks: 0,
        complete_score_stocks: 0,
        reason: 'hot_rank_snapshot has no data',
      },
    };
    if (debug || process.env.HOTRANK_DEBUG === '1') {
      console.error('[hotrank:top-trend] diagnostics', emptyPayload.diagnostics);
    }
    return emptyPayload;
  }

  const dateInList = selectedDates.map((date) => db.quote(date)).join(',');
  const rawRows = db.queryAll(`
    SELECT
      stock_code,
      MAX(stock_name) AS stock_name,
      trade_date,
      MIN(rank_no) AS rank_no,
      MAX(score) AS score
    FROM hot_rank_snapshot
    WHERE trade_date IN (${dateInList})
      AND rank_no IS NOT NULL
    GROUP BY stock_code, trade_date
    ORDER BY stock_code ASC, trade_date ASC
  `);

  const dateIndex = new Map(selectedDates.map((date, index) => [date, index]));
  const grouped = new Map();
  for (const row of rawRows) {
    const code = String(row.stock_code || '').trim();
    if (!code) continue;
    if (!grouped.has(code)) {
      grouped.set(code, {
        stock_code: code,
        stock_name: String(row.stock_name || '').trim(),
        byDate: new Map(),
      });
    }
    grouped.get(code).byDate.set(String(row.trade_date), {
      rank_no: toFiniteOrNull(row.rank_no),
      score: toFiniteOrNull(row.score),
    });
  }

  const metrics = [];
  let regressableCount = 0;
  let completeScoreCount = 0;
  for (const item of grouped.values()) {
    const rankPoints = [];
    const rankSeries = [];
    const scoreSeries = [];
    for (const date of selectedDates) {
      const row = item.byDate.get(date);
      if (!row || !Number.isFinite(row.rank_no)) {
        rankSeries.push(null);
        scoreSeries.push(null);
        continue;
      }
      const x = dateIndex.get(date);
      rankPoints.push({ x, y: row.rank_no });
      rankSeries.push(row.rank_no);
      scoreSeries.push(Number.isFinite(row.score) ? row.score : null);
    }
    if (rankPoints.length < 3) {
      continue;
    }
    regressableCount += 1;
    const rankSlope = linearRegressionSlopeFromPoints(rankPoints);
    if (!Number.isFinite(rankSlope)) continue;

    const validRanks = rankSeries.filter(Number.isFinite);
    const firstRank = validRanks[0];
    const latestRank = validRanks[validRanks.length - 1];
    const rankChange = Number.isFinite(firstRank) && Number.isFinite(latestRank) ? firstRank - latestRank : null;
    const trend5 = computeHeatTrendFromRankSeries(rankSeries, 5);
    const trend10 = computeHeatTrendFromRankSeries(rankSeries, 10);
    const trend25 = computeHeatTrendFromRankSeries(rankSeries, 25);
    if (![trend5, trend10, trend25].every((v) => Number.isFinite(v))) {
      continue;
    }
    const hnScoreDetail = computeHnAdaptedScore(rankSeries);
    if (!Number.isFinite(hnScoreDetail.score)) {
      continue;
    }
    completeScoreCount += 1;
    const trendScore = hnScoreDetail.score;

    metrics.push({
      stock_code: item.stock_code,
      stock_name: item.stock_name,
      points: rankPoints.length,
      rank_slope: Number(rankSlope.toFixed(6)),
      trend_5: Number(trend5.toFixed(6)),
      trend_10: Number(trend10.toFixed(6)),
      trend_25: Number(trend25.toFixed(6)),
      trend_score: Number(trendScore.toFixed(6)),
      hn_score: Number(trendScore.toFixed(6)),
      hn_persist_gain: Number(hnScoreDetail.persistGain.toFixed(6)),
      hn_age: Number(hnScoreDetail.age.toFixed(3)),
      hn_penalty: Number(hnScoreDetail.penalty.toFixed(6)),
      hn_max_jump: Number(hnScoreDetail.maxJump.toFixed(6)),
      latest_rank: latestRank,
      first_rank: firstRank,
      rank_change: rankChange != null ? Number(rankChange.toFixed(3)) : null,
      avg_rank: Number((validRanks.reduce((sum, value) => sum + value, 0) / validRanks.length).toFixed(3)),
      rank_series: rankSeries,
      score_series: scoreSeries,
    });
  }

  metrics.sort((a, b) => {
    if (b.trend_score !== a.trend_score) return b.trend_score - a.trend_score;
    if ((b.rank_change ?? -Infinity) !== (a.rank_change ?? -Infinity)) {
      return (b.rank_change ?? -Infinity) - (a.rank_change ?? -Infinity);
    }
    return (a.latest_rank ?? Infinity) - (b.latest_rank ?? Infinity);
  });

  const payload = {
    window_days: safeWindowDays,
    limit: safeLimit,
    dates: selectedDates,
    rows: metrics.slice(0, safeLimit),
    diagnostics: {
      total_snapshot_rows: totalSnapshotRows,
      total_distinct_trade_dates: totalDistinctDates,
      selected_trade_dates: selectedDates.length,
      candidate_stocks: grouped.size,
      regressable_stocks: regressableCount,
      complete_score_stocks: completeScoreCount,
      ranked_stocks: metrics.length,
      reason:
        metrics.length > 0
          ? 'ok'
          : 'no stock has enough valid points to compute HN-adapted score',
    },
  };
  if (debug || process.env.HOTRANK_DEBUG === '1') {
    console.error('[hotrank:top-trend] diagnostics', payload.diagnostics);
  }
  return payload;
}

export function countHotrankDistinctTradeDates(db) {
  const row = db.queryOne(`SELECT COUNT(DISTINCT trade_date) AS cnt FROM hot_rank_snapshot`);
  const n = Number(row?.cnt);
  return Number.isFinite(n) ? n : 0;
}

function linearRegressionSlopeFromPoints(points) {
  const list = Array.isArray(points) ? points : [];
  if (list.length < 2) return NaN;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const point of list) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const n = list.length;
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return NaN;
  return (n * sumXY - sumX * sumY) / denominator;
}

function computeHeatTrendFromRankSeries(rankSeries, windowDays) {
  const series = Array.isArray(rankSeries) ? rankSeries : [];
  const n = Math.max(1, Number(windowDays) || 1);
  const sliced = series.slice(-n);
  const points = [];
  for (let i = 0; i < sliced.length; i += 1) {
    const rank = Number(sliced[i]);
    if (!Number.isFinite(rank)) continue;
    points.push({ x: i, y: -rank });
  }
  if (points.length < 3) return NaN;
  return linearRegressionSlopeFromPoints(points);
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computeHnAdaptedScore(rankSeries) {
  const ALPHA = 0.9;
  const GAMMA = 1.35;
  const TAU = 7;
  const LAMBDA = 0.15;

  const ranks = Array.isArray(rankSeries) ? rankSeries : [];
  if (ranks.length < 3) {
    return { score: NaN, persistGain: 0, age: Infinity, penalty: 0, maxJump: 0 };
  }

  let persistGain = 0;
  let maxJump = 0;
  let lastPositiveIndex = -1;
  let validTransitions = 0;

  for (let i = 1; i < ranks.length; i += 1) {
    const prev = Number(ranks[i - 1]);
    const curr = Number(ranks[i]);
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
    validTransitions += 1;
    const improve = Math.max(0, prev - curr); // rank down = better
    const daysAgo = ranks.length - 1 - i;
    const weight = Math.exp(-daysAgo / TAU);
    persistGain += improve * weight;
    if (improve > maxJump) maxJump = improve;
    if (improve > 0) {
      lastPositiveIndex = i;
    }
  }

  if (validTransitions < 3) {
    return { score: NaN, persistGain, age: Infinity, penalty: 0, maxJump };
  }

  const age = lastPositiveIndex >= 0 ? ranks.length - 1 - lastPositiveIndex : ranks.length;
  const penalty = LAMBDA * maxJump;
  const adjustedGain = Math.max(0, persistGain - penalty);
  if (adjustedGain <= 0) {
    return { score: 0, persistGain, age, penalty, maxJump };
  }

  const score = Math.pow(adjustedGain, ALPHA) / Math.pow(age + 2, GAMMA);
  return { score, persistGain, age, penalty, maxJump };
}
