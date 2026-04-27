import express from 'express';
import fs from 'node:fs';
import path, { join } from 'node:path';
import { readDailyFundFlowPayload, normalizeDateInput } from '../services/storeDailyFlow.js';
import { getConfig } from '../config.js';
import { createSqliteClient, initHotrankSchema } from '../db.js';

const TURNOVER_EMA_PERIOD = 5;
const WINDOW_OPTIONS = [5, 10, 15, 20, 25];

export function startShowlineServer({ port = 7070, defaultDate = null } = {}) {
  const app = express();
  app.use('/scripts/chartjs', express.static(join(process.cwd(), 'node_modules/chart.js/dist')));

  const { hotrankDbPath } = getConfig();
  const hotrankDb = createSqliteClient(hotrankDbPath);
  initHotrankSchema(hotrankDb);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  startShowlineServer();
}
