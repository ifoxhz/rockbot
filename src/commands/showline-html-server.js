import express from 'express';
import { readDailyFundFlowPayload, normalizeDateInput } from '../services/storeDailyFlow.js';
import { join } from 'node:path';

const TURNOVER_EMA_PERIOD = 5;

export function startShowlineServer({ port = 7070, defaultDate = null } = {}) {
  const app = express();
  app.use('/scripts/chartjs', express.static(join(process.cwd(), 'node_modules/chart.js/dist')));

  app.get('/showline/:code', (req, res) => {
    const code = req.params.code;
    const date = normalizeDateInput(req.query.date) || normalizeDateInput(defaultDate);

    try {
      const { rows } = readDailyFundFlowPayload(code, date);
      if (!rows || rows.length === 0) {
        res.send('<h2>No data</h2>');
        return;
      }

      const labels = [];
      const extraLargeNet = [];
      const smallNet = [];
      const turnover = [];
      const changePct = [];
      rows.forEach((row) => {
        labels.push(row.date ? row.date.slice(5) : '??-??');

        extraLargeNet.push(Number.isFinite(Number(row.extra_large)) ? Number(row.extra_large) : null);
        smallNet.push(Number.isFinite(Number(row.small)) ? Number(row.small) : null);

        const turnoverRate = Number(row.turnover_rate);
        turnover.push(Number.isFinite(turnoverRate) ? turnoverRate : null);

        const change = Number(row.change_pct);
        if (Number.isFinite(change)) {
          changePct.push(change);
        } else {
          changePct.push(null);
        }
      });
      const maxAbsChange = 20;
      const extraLargeTrend = buildTrendLine(extraLargeNet);
      const smallTrend = buildTrendLine(smallNet);
      const turnoverTrend = buildExponentialMovingAverage(turnover, TURNOVER_EMA_PERIOD);
      const extraLargeSlopePerDay = extraLargeTrend.slope.toFixed(3);
      const smallSlopePerDay = smallTrend.slope.toFixed(3);
      const latestTurnoverTrend = turnoverTrend.line
        .filter((value) => Number.isFinite(value))
        .at(-1);
      const maxAbsNet = Math.max(
        1,
        ...extraLargeNet.filter(Number.isFinite).map((value) => Math.abs(value)),
        ...smallNet.filter(Number.isFinite).map((value) => Math.abs(value))
      );

      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${code} Fund Flow</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      </head>
      <body>
        <h2>${code} \u8d44\u91d1\u51c0\u989d\u8d8b\u52bf</h2>
        <div style="width: 66%; margin: 0 auto; font-size: 12px; color: #444;">
          <div>\u8d85\u5927\u5355\u51c0\u989d\u8d8b\u52bf\u659c\u7387: ${extraLargeSlopePerDay} / \u65e5</div>
          <div>\u5c0f\u5355\u51c0\u989d\u8d8b\u52bf\u659c\u7387: ${smallSlopePerDay} / \u65e5</div>
          <div>\u6362\u624b\u7387 EMA(${TURNOVER_EMA_PERIOD}) \u6700\u65b0\u503c: ${Number.isFinite(latestTurnoverTrend) ? latestTurnoverTrend.toFixed(2) + '%' : '-'}</div>
        </div>
        <div style="width: 66%; margin: 0 auto;">
          <canvas id="chart" width="600" height="400"></canvas>
        </div>
        <script>
          const ctx = document.getElementById('chart').getContext('2d');
          const LABEL_EXTRA_LARGE = '\\u8d85\\u5927\\u5355\\u51c0\\u989d';
          const LABEL_SMALL = '\\u5c0f\\u5355\\u51c0\\u989d';
          const LABEL_TURNOVER = '\\u6362\\u624b\\u7387';
          const LABEL_CHANGE = '\\u6da8\\u8dcc\\u5e45';
          const LABEL_TURNOVER_TREND = LABEL_TURNOVER + ' EMA(${TURNOVER_EMA_PERIOD})';
          new Chart(ctx, {
            type: 'line',
            data: {
              labels: ${JSON.stringify(labels)},
              datasets: [
                {
                  label: LABEL_EXTRA_LARGE,
                  data: ${JSON.stringify(extraLargeNet)},
                  borderColor: '#c0392b',
                  backgroundColor: 'rgba(192,57,43,0.1)',
                  fill: false,
                  tension: 0.2,
                  borderWidth: 1,
                  yAxisID: 'y'
                },
                {
                  label: LABEL_EXTRA_LARGE + '\\u8d8b\\u52bf',
                  data: ${JSON.stringify(extraLargeTrend.line)},
                  borderColor: 'rgba(192,57,43,0.7)',
                  borderDash: [6, 6],
                  fill: false,
                  tension: 0,
                  pointRadius: 0,
                  borderWidth: 1,
                  yAxisID: 'y'
                },
                {
                  label: LABEL_SMALL,
                  data: ${JSON.stringify(smallNet)},
                  borderColor: '#27ae60',
                  backgroundColor: 'rgba(39,174,96,0.1)',
                  fill: false,
                  tension: 0.2,
                  borderWidth: 1,
                  yAxisID: 'y'
                },
                {
                  label: LABEL_SMALL + '\\u8d8b\\u52bf',
                  data: ${JSON.stringify(smallTrend.line)},
                  borderColor: 'rgba(39,174,96,0.7)',
                  borderDash: [6, 6],
                  fill: false,
                  tension: 0,
                  pointRadius: 0,
                  borderWidth: 1,
                  yAxisID: 'y'
                },
                {
                  label: LABEL_TURNOVER,
                  data: ${JSON.stringify(turnover)},
                  borderColor: 'blue',
                  backgroundColor: 'rgba(0,0,255,0.08)',
                  fill: false,
                  tension: 0.2,
                  borderWidth: 1,
                  yAxisID: 'y1'
                },
                {
                  label: LABEL_TURNOVER_TREND,
                  data: ${JSON.stringify(turnoverTrend.line)},
                  borderColor: 'rgba(0,0,180,0.6)',
                  borderDash: [6, 6],
                  fill: false,
                  tension: 0,
                  pointRadius: 0,
                  borderWidth: 1,
                  yAxisID: 'y1'
                },
                {
                  label: LABEL_CHANGE,
                  data: ${JSON.stringify(changePct)},
                  borderColor: 'orange',
                  backgroundColor: 'rgba(255,165,0,0.08)',
                  fill: false,
                  tension: 0.2,
                  borderWidth: 1,
                  pointBackgroundColor: function(ctx) {
                    const v = ctx?.parsed?.y;
                    if (!Number.isFinite(v)) return 'rgba(0,0,0,0)';
                    return v < 0 ? '#d9534f' : '#5cb85c';
                  },
                  pointBorderColor: function(ctx) {
                    const v = ctx?.parsed?.y;
                    if (!Number.isFinite(v)) return 'rgba(0,0,0,0)';
                    return v < 0 ? '#b52b27' : '#3d8b3d';
                  },
                  yAxisID: 'y1'
                }
              ]
            },
            options: {
              responsive: true,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { position: 'top' },
                tooltip: {
                  callbacks: {
                    label: function(context) {
                      const label = context.dataset?.label || '';
                      const datasetLabel = context.dataset?.label || '';
                      const isTrendDataset =
                        datasetLabel === LABEL_EXTRA_LARGE + '\\u8d8b\\u52bf' ||
                        datasetLabel === LABEL_SMALL + '\\u8d8b\\u52bf';
                      if (isTrendDataset) {
                        return null;
                      }
                      const value = context.parsed?.y;
                      if (!Number.isFinite(value)) {
                        return label ? label + ': -' : '-';
                      }
                      const isTurnover = datasetLabel === LABEL_TURNOVER;
                      const isTurnoverTrend = datasetLabel === LABEL_TURNOVER_TREND;
                      const isChange = context.dataset?.label === LABEL_CHANGE;
                      const isNet = datasetLabel.startsWith(LABEL_EXTRA_LARGE) || datasetLabel.startsWith(LABEL_SMALL);
                      const percent = isTurnover || isTurnoverTrend
                        ? Number(value).toFixed(2)
                        : isChange
                          ? Number(value).toFixed(2)
                          : isNet
                            ? Number(value).toFixed(3)
                            : (Number(value) * 100).toFixed(0);
                      const suffix = isNet ? ' million' : '%';
                      return label ? label + ': ' + percent + suffix : percent + suffix;
                    }
                  }
                }
              },
              scales: {
                y: {
                  position: 'left',
                  beginAtZero: false,
                  suggestedMin: -${maxAbsNet.toFixed(3)},
                  suggestedMax: ${maxAbsNet.toFixed(3)},
                  ticks: {
                    callback: function(value) {
                      return Number(value).toFixed(1) + 'm';
                    }
                  }
                },
                y1: {
                  position: 'right',
                  beginAtZero: false,
                  suggestedMin: -${maxAbsChange},
                  suggestedMax: ${maxAbsChange},
                  grid: {
                    drawOnChartArea: true,
                    color: function(ctx) {
                      return ctx.tick?.value === 0 ? '#666' : 'rgba(0,0,0,0.05)';
                    },
                    lineWidth: function(ctx) {
                      return ctx.tick?.value === 0 ? 1.0 : 0.4;
                    },
                    borderDash: function(ctx) {
                      return ctx.tick?.value === 0 ? [4, 4] : [];
                    }
                  },
                  ticks: {
                    stepSize: 2,
                    callback: function(value) {
                      return Number(value).toFixed(2) + '%';
                    }
                  }
                },
                x: {
                  ticks: {
                    maxRotation: 45,
                    minRotation: 0
                  }
                }
              }
            }
          });
        </script>
      </body>
      </html>
    `;
      res.send(html);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal error');
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

if (import.meta.url === `file://${process.argv[1]}`) {
  startShowlineServer();
}
