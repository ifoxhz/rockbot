import express from 'express';
import fs from 'node:fs';
import path, { join } from 'node:path';
import { readDailyFundFlowPayload, normalizeDateInput } from '../services/storeDailyFlow.js';
import { getConfig } from '../config.js';
import { createSqliteClient, initHotrankSchema } from '../db.js';
import { buildHotrankTopTrendPayload as buildHotrankTopTrendPayloadService } from '../services/hotrank/topTrend.js';

const TURNOVER_EMA_PERIOD = 5;
const WINDOW_OPTIONS = [5, 10, 15, 20, 25];

export function startShowlineServer({ port = 7070, defaultDate = null } = {}) {
  const app = express();
  app.use('/scripts/chartjs', express.static(join(process.cwd(), 'node_modules/chart.js/dist')));

  const { hotrankDbPath } = getConfig();
  const hotrankDb = createSqliteClient(hotrankDbPath);
  initHotrankSchema(hotrankDb);

  app.get('/showline/hotrank/top-trend', (_req, res) => {
    const html = renderHotrankTopTrendPage();
    res.send(html);
  });

  app.get('/showline/hotrank/:tsCode', (req, res) => {
    const tsCode = normalizeTsCode(req.params.tsCode);
    const html = renderHotrankTrendPage({ tsCode });
    res.send(html);
  });

  app.get('/showline/:code', (req, res) => {
    const code = req.params.code;
    const date = normalizeDateInput(req.query.date) || normalizeDateInput(defaultDate);
    const html = renderTrendPage({ code, date });
    res.send(html);
  });

  app.get('/api/showline/dates', (_req, res) => {
    try {
      res.json({ dates: listAvailableDataDates() });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/showline/trend/:code', (req, res) => {
    try {
      const code = req.params.code;
      const date = normalizeDateInput(req.query.date) || normalizeDateInput(defaultDate);
      const windowSize = normalizeWindow(req.query.window);
      const offset = normalizeOffset(req.query.offset);
      const payload = buildTrendPayload({ code, date, windowSize, offset });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/showline/analysis/:code', (req, res) => {
    try {
      const code = req.params.code;
      const date = normalizeDateInput(req.query.date) || normalizeDateInput(defaultDate);
      const payload = readAnalysisForCode({ code, date });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/showline/hotrank/history/:tsCode', (req, res) => {
    try {
      const tsCode = normalizeTsCode(req.params.tsCode);
      const limit = Math.max(1, Number(req.query.limit) || 120);
      const rows = hotrankDb.queryAll(`
        SELECT trade_date, capture_time, stock_code, stock_name, rank_no, score, price, pct_chg
        FROM hot_rank_snapshot
        WHERE stock_code = ${hotrankDb.quote(tsCode)}
        ORDER BY capture_time DESC
        LIMIT ${limit}
      `);
      res.json({ ts_code: tsCode, rows });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/showline/hotrank/trend/:tsCode', (req, res) => {
    try {
      const tsCode = normalizeTsCode(req.params.tsCode);
      const windowSize = normalizeWindow(req.query.window);
      const offset = normalizeOffset(req.query.offset);
      const payload = buildHotrankTrendPayload({
        db: hotrankDb,
        tsCode,
        windowSize,
        offset,
      });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/showline/hotrank/top-trend', (req, res) => {
    try {
      const windowDays = normalizePositiveInt(req.query.window, 25);
      const limit = normalizePositiveInt(req.query.limit, 10);
      const debug = String(req.query.debug || '').trim() === '1';
      const payload = buildHotrankTopTrendPayloadService({
        db: hotrankDb,
        windowDays,
        limit,
        debug,
      });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/showline/hotrank/features/:tsCode', (req, res) => {
    try {
      const tsCode = normalizeTsCode(req.params.tsCode);
      const limit = Math.max(1, Number(req.query.limit) || 30);
      const rows = hotrankDb.queryAll(`
        SELECT stock_code, calc_time, rank_now, rank_prev, heat_speed, appear_7d, top10_30d
        FROM hot_features
        WHERE stock_code = ${hotrankDb.quote(tsCode)}
        ORDER BY calc_time DESC
        LIMIT ${limit}
      `);
      res.json({ ts_code: tsCode, rows });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/showline/hotrank/signals/latest', (_req, res) => {
    try {
      const latest = hotrankDb.queryOne(`
        SELECT signal_time
        FROM signals
        ORDER BY signal_time DESC
        LIMIT 1
      `);
      if (!latest?.signal_time) {
        res.json({ signal_time: null, rows: [] });
        return;
      }
      const rows = hotrankDb.queryAll(`
        SELECT signal_time, ts_code, stock_name, signal_type, score, reason
        FROM signals
        WHERE signal_time = ${hotrankDb.quote(latest.signal_time)}
        ORDER BY score DESC
      `);
      res.json({ signal_time: latest.signal_time, rows });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`HTTP server running at http://0.0.0.0:${port}`);
  });

  return server;
}

function buildTrendLine(series) {
  const n = series.length;
  if (n === 0) return { slope: 0, intercept: 0, line: [] };

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = Number(series[i]) || 0;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }

  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const line = [];
  for (let i = 0; i < n; i++) {
    line.push(slope * i + intercept);
  }

  return { slope, intercept, line };
}

function buildExponentialMovingAverage(series, period = 5) {
  const n = Array.isArray(series) ? series.length : 0;
  if (n === 0) return { period, line: [] };

  const safePeriod = Math.max(1, Number(period) || 1);
  const multiplier = 2 / (safePeriod + 1);
  const line = [];
  let ema = null;

  for (let i = 0; i < n; i++) {
    const value = series[i];
    if (!Number.isFinite(value)) {
      line.push(ema);
      continue;
    }

    ema = ema == null ? value : value * multiplier + ema * (1 - multiplier);
    line.push(ema);
  }

  return { period: safePeriod, line };
}

function buildTrendPayload({ code, date, windowSize, offset }) {
  const { rows } = readDailyFundFlowPayload(code, date);
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      code,
      date: date || null,
      total_rows: 0,
      available_windows: WINDOW_OPTIONS,
      window_size: windowSize,
      offset,
      max_offset: 0,
      rows: [],
      series: {},
      metrics: {},
    };
  }

  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const maxOffset = Math.max(0, sorted.length - windowSize);
  const safeOffset = Math.min(Math.max(0, offset), maxOffset);
  const endExclusive = sorted.length - safeOffset;
  const start = Math.max(0, endExclusive - windowSize);
  const windowRows = sorted.slice(start, endExclusive);

  const labels = windowRows.map((row) => (row.date ? String(row.date).slice(5) : '??-??'));
  const extraLargeNet = windowRows.map((row) =>
    Number.isFinite(Number(row.extra_large)) ? Number(row.extra_large) : null
  );
  const smallNet = windowRows.map((row) => (Number.isFinite(Number(row.small)) ? Number(row.small) : null));
  const turnover = windowRows.map((row) => {
    const v = Number(row.turnover_rate);
    return Number.isFinite(v) ? v : null;
  });
  const changePct = windowRows.map((row) => {
    const v = Number(row.change_pct);
    return Number.isFinite(v) ? v : null;
  });

  const extraLargeTrend = buildTrendLine(extraLargeNet);
  const smallTrend = buildTrendLine(smallNet);
  const turnoverTrend = buildExponentialMovingAverage(turnover, TURNOVER_EMA_PERIOD);

  const latestTurnoverTrend = turnoverTrend.line.filter(Number.isFinite).at(-1);
  const maxAbsNet = Math.max(
    1,
    ...extraLargeNet.filter(Number.isFinite).map((value) => Math.abs(value)),
    ...smallNet.filter(Number.isFinite).map((value) => Math.abs(value))
  );

  return {
    code,
    date: date || null,
    total_rows: sorted.length,
    available_windows: WINDOW_OPTIONS,
    window_size: windowSize,
    offset: safeOffset,
    max_offset: maxOffset,
    start_index: start,
    end_index: endExclusive - 1,
    rows: windowRows,
    series: {
      labels,
      extra_large_net: extraLargeNet,
      extra_large_trend: extraLargeTrend.line,
      small_net: smallNet,
      small_trend: smallTrend.line,
      turnover_rate: turnover,
      turnover_ema: turnoverTrend.line,
      change_pct: changePct,
    },
    metrics: {
      extra_large_slope: Number(extraLargeTrend.slope.toFixed(6)),
      small_slope: Number(smallTrend.slope.toFixed(6)),
      latest_turnover_ema: Number.isFinite(latestTurnoverTrend)
        ? Number(latestTurnoverTrend.toFixed(4))
        : null,
      turnover_ema_period: TURNOVER_EMA_PERIOD,
      max_abs_net: Number(maxAbsNet.toFixed(3)),
    },
  };
}

function listAvailableDataDates() {
  const baseDir = path.resolve('data/daily_fund_flow');
  if (!fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

function readAnalysisForCode({ code, date }) {
  const analysisDate = normalizeDateInput(date) || listAvailableAnalysisDates()[0] || null;
  if (!analysisDate) {
    return { analysis_date: null, code, result: null };
  }

  const filePath = path.resolve('data/analysis', `${analysisDate}.json`);
  if (!fs.existsSync(filePath)) {
    return { analysis_date: analysisDate, code, result: null };
  }
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const result = Array.isArray(payload?.results)
    ? payload.results.find((item) => String(item?.code || '') === String(code))
    : null;
  return { analysis_date: analysisDate, code, result: result || null };
}

function listAvailableAnalysisDates() {
  const baseDir = path.resolve('data/analysis');
  if (!fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
    .map((entry) => entry.name.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

function normalizeWindow(input) {
  const n = Number(input);
  if (WINDOW_OPTIONS.includes(n)) return n;
  return 25;
}

function normalizeOffset(input) {
  const n = Number.parseInt(String(input || '0'), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function normalizeTsCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (/^\d{6}\.(SZ|SH)$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) {
    return s.startsWith('6') ? `${s}.SH` : `${s}.SZ`;
  }
  return s;
}

function buildHotrankTrendPayload({ db, tsCode, windowSize, offset }) {
  const rows = db.queryAll(`
    SELECT trade_date, capture_time, rank_no, score, price, pct_chg, stock_name
    FROM hot_rank_snapshot
    WHERE stock_code = ${db.quote(tsCode)}
      AND rank_no IS NOT NULL
    ORDER BY trade_date ASC, capture_time ASC
    LIMIT 1000
  `);
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ts_code: tsCode,
      stock_name: '',
      total_rows: 0,
      available_windows: WINDOW_OPTIONS,
      window_size: windowSize,
      offset: 0,
      max_offset: 0,
      rows: [],
      series: {},
      metrics: {},
    };
  }

  const maxOffset = Math.max(0, rows.length - windowSize);
  const safeOffset = Math.min(Math.max(0, offset), maxOffset);
  const endExclusive = rows.length - safeOffset;
  const start = Math.max(0, endExclusive - windowSize);
  const windowRows = rows.slice(start, endExclusive);
  const rankSeries = windowRows.map((row) => {
    const n = Number(row.rank_no);
    return Number.isFinite(n) ? n : null;
  });
  const scoreSeries = windowRows.map((row) => {
    const n = Number(row.score);
    return Number.isFinite(n) ? n : null;
  });
  const rankTrend = buildTrendLine(rankSeries);
  const validRanks = rankSeries.filter(Number.isFinite);
  const avgRank =
    validRanks.length > 0 ? validRanks.reduce((sum, value) => sum + value, 0) / validRanks.length : null;
  const bestRank = validRanks.length > 0 ? Math.min(...validRanks) : null;
  const latestNamedRowInWindow = [...windowRows]
    .reverse()
    .find((row) => String(row?.stock_name || '').trim().length > 0);
  const latestNamedRow = [...rows]
    .reverse()
    .find((row) => String(row?.stock_name || '').trim().length > 0);
  const stockName = String(latestNamedRowInWindow?.stock_name || latestNamedRow?.stock_name || '').trim();

  return {
    ts_code: tsCode,
    stock_name: stockName,
    total_rows: rows.length,
    available_windows: WINDOW_OPTIONS,
    window_size: windowSize,
    offset: safeOffset,
    max_offset: maxOffset,
    start_index: start,
    end_index: endExclusive - 1,
    rows: windowRows,
    series: {
      labels: windowRows.map((row) => formatHotrankLabel(row.trade_date, row.capture_time)),
      rank: rankSeries,
      rank_trend: rankTrend.line,
      score: scoreSeries,
      price: windowRows.map((row) => toFiniteOrNull(row.price)),
      pct_chg: windowRows.map((row) => toFiniteOrNull(row.pct_chg)),
    },
    metrics: {
      rank_slope: Number(rankTrend.slope.toFixed(6)),
      avg_rank: avgRank != null ? Number(avgRank.toFixed(3)) : null,
      best_rank: bestRank,
      latest_rank: validRanks.length > 0 ? validRanks[validRanks.length - 1] : null,
    },
  };
}

function formatHotrankLabel(tradeDate, captureTime) {
  const d = String(tradeDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return d.slice(5);
  }
  const s = String(captureTime || '').trim();
  if (!s) return '';
  if (s.includes('T')) return s.slice(5, 10);
  return s.slice(5, 10);
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function buildHotrankTopTrendPayload({ db, windowDays, limit, debug = false }) {
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
    LIMIT ${Math.max(1, windowDays)}
  `);
  const selectedDatesDesc = dateRows.map((row) => String(row.trade_date || '')).filter(Boolean);
  const selectedDates = [...selectedDatesDesc].reverse();
  if (selectedDates.length === 0) {
    const emptyPayload = {
      window_days: windowDays,
      limit,
      dates: [],
      rows: [],
      diagnostics: {
        total_snapshot_rows: totalSnapshotRows,
        total_distinct_trade_dates: totalDistinctDates,
        selected_trade_dates: 0,
        candidate_stocks: 0,
        regressable_stocks: 0,
        reason: 'hot_rank_snapshot has no data',
      },
    };
    if (debug || process.env.HOTRANK_DEBUG === '1') {
      console.error('[showline] hotrank top trend diagnostics', emptyPayload.diagnostics);
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
    completeScoreCount += 1;
    const trendScore = 0.5 * trend5 + 0.3 * trend10 + 0.2 * trend25;

    metrics.push({
      stock_code: item.stock_code,
      stock_name: item.stock_name,
      points: rankPoints.length,
      rank_slope: Number(rankSlope.toFixed(6)),
      trend_5: Number(trend5.toFixed(6)),
      trend_10: Number(trend10.toFixed(6)),
      trend_25: Number(trend25.toFixed(6)),
      trend_score: Number(trendScore.toFixed(6)),
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
    window_days: windowDays,
    limit,
    dates: selectedDates,
    rows: metrics.slice(0, Math.max(1, limit)),
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
          : 'no stock has enough valid points to compute trend_5/10/25 score',
    },
  };
  if (debug || process.env.HOTRANK_DEBUG === '1') {
    console.error('[showline] hotrank top trend diagnostics', payload.diagnostics);
  }
  return payload;
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
    // rank 越小越热，所以热度趋势用 -rank 的斜率表示“上升速度”
    points.push({ x: i, y: -rank });
  }
  if (points.length < 3) return NaN;
  return linearRegressionSlopeFromPoints(points);
}

function renderTrendPage({ code, date }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${code} showline</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #222; }
    .wrap { max-width: 1100px; margin: 0 auto; }
    .toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .metric { font-size: 13px; color: #444; margin: 4px 0; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-top: 12px; }
    input[type="range"] { width: 240px; }
    pre { background: #f8f8f8; padding: 8px; border-radius: 6px; overflow: auto; }
  </style>
</head>
<body>
  <div class="wrap">
    <h2>${code} 资金趋势查看</h2>
    <div class="toolbar">
      <label>日期:
        <input id="dateInput" value="${date || ''}" placeholder="YYYY-MM-DD" />
      </label>
      <label>窗口:
        <select id="windowSelect">
          <option value="5">5天</option>
          <option value="10">10天</option>
          <option value="15">15天</option>
          <option value="20">20天</option>
          <option value="25" selected>25天</option>
        </select>
      </label>
      <label>滑动:
        <input id="offsetRange" type="range" min="0" max="0" value="0" step="1" />
        <span id="offsetText">0</span>
      </label>
      <button id="refreshBtn">刷新</button>
    </div>

    <div class="metric" id="metricText"></div>
    <canvas id="chart" height="120"></canvas>

    <div class="card">
      <strong>分析结果 (analysis)</strong>
      <pre id="analysisBox">-</pre>
    </div>
    <div class="card">
      <strong>Hotrank 特征 (latest)</strong>
      <pre id="hotFeatureBox">-</pre>
    </div>
    <div class="card">
      <strong>Hotrank 最新信号</strong>
      <pre id="hotSignalBox">-</pre>
    </div>
  </div>

  <script>
    const code = ${JSON.stringify(code)};
    let chart = null;
    const elDate = document.getElementById('dateInput');
    const elWindow = document.getElementById('windowSelect');
    const elOffset = document.getElementById('offsetRange');
    const elOffsetText = document.getElementById('offsetText');
    const elMetric = document.getElementById('metricText');
    const analysisBox = document.getElementById('analysisBox');
    const hotFeatureBox = document.getElementById('hotFeatureBox');
    const hotSignalBox = document.getElementById('hotSignalBox');

    async function refresh() {
      const date = (elDate.value || '').trim();
      const windowSize = Number(elWindow.value);
      const offset = Number(elOffset.value || 0);
      const query = new URLSearchParams();
      if (date) query.set('date', date);
      query.set('window', String(windowSize));
      query.set('offset', String(offset));
      const trendRes = await fetch('/api/showline/trend/' + encodeURIComponent(code) + '?' + query.toString());
      const trend = await trendRes.json();
      if (trend.error) {
        alert(trend.error);
        return;
      }

      elOffset.max = String(trend.max_offset || 0);
      if (Number(elOffset.value) > Number(elOffset.max)) {
        elOffset.value = elOffset.max;
      }
      elOffsetText.textContent = elOffset.value;
      renderChart(trend);

      elMetric.textContent =
        '窗口=' + trend.window_size +
        ', offset=' + trend.offset +
        ', 超大单斜率=' + trend.metrics.extra_large_slope +
        ', 小单斜率=' + trend.metrics.small_slope +
        ', EMA(' + trend.metrics.turnover_ema_period + ')=' + (trend.metrics.latest_turnover_ema ?? '-');

      const analysisRes = await fetch('/api/showline/analysis/' + encodeURIComponent(code) + (date ? ('?date=' + encodeURIComponent(date)) : ''));
      const analysis = await analysisRes.json();
      analysisBox.textContent = JSON.stringify(analysis, null, 2);

      const tsCode = normalizeTsCode(code);
      const hotFeatureRes = await fetch('/api/showline/hotrank/features/' + encodeURIComponent(tsCode) + '?limit=5');
      const hotFeature = await hotFeatureRes.json();
      hotFeatureBox.textContent = JSON.stringify(hotFeature, null, 2);

      const hotSignalRes = await fetch('/api/showline/hotrank/signals/latest');
      const hotSignal = await hotSignalRes.json();
      hotSignalBox.textContent = JSON.stringify(hotSignal, null, 2);
    }

    function renderChart(payload) {
      const labels = payload.series.labels;
      const data = payload.series;
      const ctx = document.getElementById('chart').getContext('2d');
      const maxAbsNet = Math.max(1, Number(payload.metrics.max_abs_net) || 1);
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: '超大单净额', data: data.extra_large_net, borderColor: '#c0392b', yAxisID: 'y' },
            { label: '超大单趋势', data: data.extra_large_trend, borderColor: 'rgba(192,57,43,0.7)', borderDash: [6, 6], pointRadius: 0, yAxisID: 'y' },
            { label: '小单净额', data: data.small_net, borderColor: '#27ae60', yAxisID: 'y' },
            { label: '小单趋势', data: data.small_trend, borderColor: 'rgba(39,174,96,0.7)', borderDash: [6, 6], pointRadius: 0, yAxisID: 'y' },
            { label: '换手率', data: data.turnover_rate, borderColor: '#1f4ed8', yAxisID: 'y1' },
            { label: '换手率 EMA', data: data.turnover_ema, borderColor: 'rgba(31,78,216,0.7)', borderDash: [6, 6], pointRadius: 0, yAxisID: 'y1' },
            { label: '涨跌幅', data: data.change_pct, borderColor: '#f59e0b', yAxisID: 'y1' },
          ],
        },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: {
              position: 'left',
              suggestedMin: -maxAbsNet,
              suggestedMax: maxAbsNet,
            },
            y1: {
              position: 'right',
              suggestedMin: -20,
              suggestedMax: 20,
              grid: { drawOnChartArea: false },
            },
          },
        },
      });
    }

    function normalizeTsCode(raw) {
      const s = String(raw || '').trim().toUpperCase();
      if (/^\\d{6}\\.(SZ|SH)$/.test(s)) return s;
      if (/^\\d{6}$/.test(s)) return s.startsWith('6') ? s + '.SH' : s + '.SZ';
      return s;
    }

    document.getElementById('refreshBtn').addEventListener('click', refresh);
    elWindow.addEventListener('change', () => {
      elOffset.value = '0';
      elOffsetText.textContent = '0';
      refresh();
    });
    elOffset.addEventListener('input', () => {
      elOffsetText.textContent = elOffset.value;
      refresh();
    });

    refresh();
  </script>
</body>
</html>`;
}

function renderHotrankTrendPage({ tsCode }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${tsCode} hotrank</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #222; }
    .wrap { max-width: 1100px; margin: 0 auto; }
    .toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .metric { font-size: 13px; color: #444; margin: 4px 0; }
    input[type="range"] { width: 240px; }
    pre { background: #f8f8f8; padding: 8px; border-radius: 6px; overflow: auto; }
  </style>
</head>
<body>
  <div class="wrap">
    <h2 id="title">${tsCode} Hotrank 趋势</h2>
    <div class="toolbar">
      <label>窗口:
        <select id="windowSelect">
          <option value="5">5点</option>
          <option value="10">10点</option>
          <option value="15">15点</option>
          <option value="20">20点</option>
          <option value="25" selected>25点</option>
        </select>
      </label>
      <label>滑动:
        <input id="offsetRange" type="range" min="0" max="0" value="0" step="1" />
        <span id="offsetText">0</span>
      </label>
      <button id="refreshBtn">刷新</button>
    </div>
    <div class="metric" id="metricText"></div>
    <canvas id="chart" height="120"></canvas>
    <h3>最新信号</h3>
    <pre id="signalBox">-</pre>
  </div>
  <script>
    const tsCode = ${JSON.stringify(tsCode)};
    let chart = null;
    const elWindow = document.getElementById('windowSelect');
    const elOffset = document.getElementById('offsetRange');
    const elOffsetText = document.getElementById('offsetText');
    const elMetric = document.getElementById('metricText');
    const signalBox = document.getElementById('signalBox');

    async function refresh() {
      const query = new URLSearchParams();
      query.set('window', String(Number(elWindow.value)));
      query.set('offset', String(Number(elOffset.value || 0)));
      const trendRes = await fetch('/api/showline/hotrank/trend/' + encodeURIComponent(tsCode) + '?' + query.toString());
      const trend = await trendRes.json();
      if (trend.error) {
        alert(trend.error);
        return;
      }
      elOffset.max = String(trend.max_offset || 0);
      if (Number(elOffset.value) > Number(elOffset.max)) {
        elOffset.value = elOffset.max;
      }
      elOffsetText.textContent = elOffset.value;
      const displayName = (trend.stock_name ? (trend.stock_name + ' ') : '') + trend.ts_code;
      document.getElementById('title').textContent = displayName + ' Hotrank 趋势';
      document.title = displayName + ' hotrank';
      elMetric.textContent =
        '窗口=' + trend.window_size +
        ', offset=' + trend.offset +
        ', 最新排名=' + (trend.metrics.latest_rank ?? '-') +
        ', 最佳排名=' + (trend.metrics.best_rank ?? '-') +
        ', 平均排名=' + (trend.metrics.avg_rank ?? '-') +
        ', 排名斜率=' + (trend.metrics.rank_slope ?? '-');
      renderChart(trend);

      const signalRes = await fetch('/api/showline/hotrank/signals/latest');
      const signal = await signalRes.json();
      const mine = Array.isArray(signal.rows) ? signal.rows.filter((row) => row.ts_code === tsCode) : [];
      signalBox.textContent = JSON.stringify({ signal_time: signal.signal_time, rows: mine }, null, 2);
    }

    function renderChart(payload) {
      const ctx = document.getElementById('chart').getContext('2d');
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: payload.series.labels,
          datasets: [
            { label: '排名(越小越热)', data: payload.series.rank, borderColor: '#e11d48', yAxisID: 'y' },
            { label: '排名趋势', data: payload.series.rank_trend, borderColor: 'rgba(225,29,72,0.6)', borderDash: [6,6], pointRadius: 0, yAxisID: 'y' },
            { label: '热度分', data: payload.series.score, borderColor: '#2563eb', yAxisID: 'y1' },
            { label: '涨跌幅(%)', data: payload.series.pct_chg, borderColor: '#16a34a', yAxisID: 'y2' }
          ],
        },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: {
              position: 'left',
              reverse: true,
              suggestedMin: 1,
              suggestedMax: 100
            },
            y1: {
              position: 'right',
              grid: { drawOnChartArea: false }
            },
            y2: {
              position: 'right',
              grid: { drawOnChartArea: false },
              suggestedMin: -10,
              suggestedMax: 10
            }
          },
        },
      });
    }

    document.getElementById('refreshBtn').addEventListener('click', refresh);
    elWindow.addEventListener('change', () => {
      elOffset.value = '0';
      elOffsetText.textContent = '0';
      refresh();
    });
    elOffset.addEventListener('input', () => {
      elOffsetText.textContent = elOffset.value;
      refresh();
    });
    refresh();
  </script>
</body>
</html>`;
}

function renderHotrankTopTrendPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Hotrank Top Trend</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #222; }
    .wrap { max-width: 1200px; margin: 0 auto; }
    .toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
    th { background: #f5f5f5; }
    a { color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <h2>Hotrank 趋势上升最快 Top10</h2>
    <div class="toolbar">
      <label>统计窗口(天):
        <input id="windowInput" type="number" min="3" max="120" value="25" />
      </label>
      <label>TopN:
        <input id="limitInput" type="number" min="1" max="50" value="10" />
      </label>
      <button id="refreshBtn">刷新</button>
    </div>
    <div id="metaText"></div>
    <div id="diagText" style="font-size:12px;color:#666;margin:6px 0 10px 0;"></div>
    <canvas id="barChart" height="120"></canvas>
    <h3>明细</h3>
    <table id="resultTable">
      <thead>
        <tr>
          <th>#</th><th>股票</th><th>名称</th><th>hn_score</th><th>persist_gain</th><th>age</th><th>max_jump</th><th>trend_5</th><th>trend_10</th><th>trend_25</th><th>首日排名</th><th>最新排名</th><th>排名改善</th><th>平均排名</th><th>点数</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <script>
    let chart = null;
    const elWindow = document.getElementById('windowInput');
    const elLimit = document.getElementById('limitInput');
    const tableBody = document.querySelector('#resultTable tbody');
    const metaText = document.getElementById('metaText');
    const diagText = document.getElementById('diagText');

    async function refresh() {
      const windowDays = Math.max(3, Number(elWindow.value) || 25);
      const limit = Math.max(1, Number(elLimit.value) || 10);
      const query = new URLSearchParams({ window: String(windowDays), limit: String(limit), debug: '1' });
      const res = await fetch('/api/showline/hotrank/top-trend?' + query.toString());
      const payload = await res.json();
      if (payload.error) {
        alert(payload.error);
        return;
      }
      metaText.textContent = '日期范围: ' + (payload.dates?.[0] || '-') + ' ~ ' + (payload.dates?.[payload.dates.length - 1] || '-') +
        ' | 样本天数=' + payload.dates.length + ' | 返回=' + payload.rows.length;
      const d = payload.diagnostics || {};
      diagText.textContent =
        'diagnostics | total_rows=' + (d.total_snapshot_rows ?? '-') +
        ' | distinct_dates=' + (d.total_distinct_trade_dates ?? '-') +
        ' | selected_dates=' + (d.selected_trade_dates ?? '-') +
        ' | candidate=' + (d.candidate_stocks ?? '-') +
        ' | regressable=' + (d.regressable_stocks ?? '-') +
        ' | complete_score=' + (d.complete_score_stocks ?? '-') +
        ' | reason=' + (d.reason || '-');
      renderChart(payload.rows);
      renderTable(payload.rows);
    }

    function renderChart(rows) {
      const ctx = document.getElementById('barChart').getContext('2d');
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: rows.map((row) => row.stock_code),
          datasets: [
            { label: 'hn_score', data: rows.map((row) => row.hn_score ?? row.trend_score), backgroundColor: '#e11d48' },
            { label: 'persist_gain', data: rows.map((row) => row.hn_persist_gain), backgroundColor: '#2563eb' },
            { label: 'age', data: rows.map((row) => row.hn_age), backgroundColor: '#16a34a' },
            { label: 'max_jump', data: rows.map((row) => row.hn_max_jump), backgroundColor: '#f59e0b' }
          ]
        },
        options: { responsive: true }
      });
    }

    function renderTable(rows) {
      tableBody.innerHTML = '';
      rows.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = [
          index + 1,
          '<a href="/showline/hotrank/' + encodeURIComponent(row.stock_code) + '" target="_blank">' + row.stock_code + '</a>',
          row.stock_name || '',
          row.hn_score ?? row.trend_score ?? '',
          row.hn_persist_gain ?? '',
          row.hn_age ?? '',
          row.hn_max_jump ?? '',
          row.trend_5 ?? '',
          row.trend_10 ?? '',
          row.trend_25 ?? '',
          row.first_rank ?? '',
          row.latest_rank ?? '',
          row.rank_change ?? '',
          row.avg_rank ?? '',
          row.points ?? ''
        ].map((value) => '<td>' + value + '</td>').join('');
        tableBody.appendChild(tr);
      });
    }

    document.getElementById('refreshBtn').addEventListener('click', refresh);
    refresh();
  </script>
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startShowlineServer();
}
