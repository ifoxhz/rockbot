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
      const buy = [];
      const sell = [];
      const turnover = [];
      const changePct = [];
      const changePctValues = [];
      rows.forEach((row) => {
        labels.push(row.date ? row.date.slice(5) : '??-??');

        const smallBuy = Number(row.small_buy) || 0;
        const mediumBuy = Number(row.medium_buy) || 0;
        const largeBuy = Number(row.large_buy) || 0;
        const extraLargeBuy = Number(row.extra_large_buy) || 0;
        const totalBuy = smallBuy + mediumBuy + largeBuy + extraLargeBuy;
        buy.push(totalBuy > 0 ? extraLargeBuy / totalBuy : 0);

        const smallSell = Number(row.small_sell) || 0;
        const mediumSell = Number(row.medium_sell) || 0;
        const largeSell = Number(row.large_sell) || 0;
        const extraLargeSell = Number(row.extra_large_sell) || 0;
        const totalSell = smallSell + mediumSell + largeSell + extraLargeSell;
        sell.push(totalSell > 0 ? extraLargeSell / totalSell : 0);

        const turnoverRate = Number(row.turnover_rate);
        turnover.push(Number.isFinite(turnoverRate) ? turnoverRate / 100 : null);

        const change = Number(row.change_pct);
        if (Number.isFinite(change)) {
          changePct.push(change);
          changePctValues.push(change);
        } else {
          changePct.push(null);
        }
      });
      const maxAbsChange = 20;
      const buyTrend = buildTrendLine(buy);
      const sellTrend = buildTrendLine(sell);
      const turnoverTrend = buildExponentialMovingAverage(turnover, TURNOVER_EMA_PERIOD);
      const buySlopePctPerDay = (buyTrend.slope * 100).toFixed(3);
      const sellSlopePctPerDay = (sellTrend.slope * 100).toFixed(3);
      const latestTurnoverTrend = turnoverTrend.line
        .filter((value) => Number.isFinite(value))
        .at(-1);

      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${code} Fund Flow</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      </head>
      <body>
        <h2>${code} \u6bd4\u4f8b\u8d8b\u52bf</h2>
        <div style="width: 66%; margin: 0 auto; font-size: 12px; color: #444;">
          <div>\u4e70\u5165\u8d8b\u52bf\u659c\u7387: ${buySlopePctPerDay}% / \u65e5</div>
          <div>\u5356\u51fa\u8d8b\u52bf\u659c\u7387: ${sellSlopePctPerDay}% / \u65e5</div>
          <div>\u6362\u624b\u7387 EMA(${TURNOVER_EMA_PERIOD}) \u6700\u65b0\u503c: ${Number.isFinite(latestTurnoverTrend) ? (latestTurnoverTrend * 100).toFixed(2) + '%' : '-'}</div>
        </div>
        <div style="width: 66%; margin: 0 auto;">
          <canvas id="chart" width="600" height="400"></canvas>
        </div>
        <script>
          const ctx = document.getElementById('chart').getContext('2d');
          const LABEL_BUY = '\\u4e70\\u5165\\u5360\\u6bd4';
          const LABEL_SELL = '\\u5356\\u51fa\\u5360\\u6bd4';
          const LABEL_TURNOVER = '\\u6362\\u624b\\u7387';
          const LABEL_CHANGE = '\\u6da8\\u8dcc\\u5e45';
          const LABEL_TURNOVER_TREND = LABEL_TURNOVER + ' EMA(${TURNOVER_EMA_PERIOD})';
          new Chart(ctx, {
            type: 'line',
            data: {
              labels: ${JSON.stringify(labels)},
              datasets: [
                {
                  label: LABEL_BUY,
                  data: ${JSON.stringify(buy)},
                  borderColor: 'green',
                  backgroundColor: 'rgba(0,255,0,0.1)',
                  fill: false,
                  tension: 0.2,
                  borderWidth: 1
                },
                {
                  label: LABEL_BUY + '\\u8d8b\\u52bf',
                  data: ${JSON.stringify(buyTrend.line)},
                  borderColor: 'rgba(0,128,0,0.6)',
                  borderDash: [6, 6],
                  fill: false,
                  tension: 0,
                  pointRadius: 0,
                  borderWidth: 1
                },
                {
                  label: LABEL_SELL,
                  data: ${JSON.stringify(sell)},
                  borderColor: 'red',
                  backgroundColor: 'rgba(255,0,0,0.1)',
                  fill: false,
                  tension: 0.2,
                  borderWidth: 1
                },
                {
                  label: LABEL_SELL + '\\u8d8b\\u52bf',
                  data: ${JSON.stringify(sellTrend.line)},
                  borderColor: 'rgba(200,0,0,0.6)',
                  borderDash: [6, 6],
                  fill: false,
                  tension: 0,
                  pointRadius: 0,
                  borderWidth: 1
                },
                {
                  label: LABEL_TURNOVER,
                  data: ${JSON.stringify(turnover)},
                  borderColor: 'blue',
                  backgroundColor: 'rgba(0,0,255,0.08)',
                  fill: false,
                  tension: 0.2,
                  borderWidth: 1
                },
                {
                  label: LABEL_TURNOVER_TREND,
                  data: ${JSON.stringify(turnoverTrend.line)},
                  borderColor: 'rgba(0,0,180,0.6)',
                  borderDash: [6, 6],
                  fill: false,
                  tension: 0,
                  pointRadius: 0,
                  borderWidth: 1
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
                      const value = context.parsed?.y;
                      if (!Number.isFinite(value)) {
                        return label ? label + ': -' : '-';
                      }
                      const isTurnover = context.dataset?.label === LABEL_TURNOVER;
                      const isTurnoverTrend = context.dataset?.label === LABEL_TURNOVER_TREND;
                      const isChange = context.dataset?.label === LABEL_CHANGE;
                      const percent = isTurnover || isTurnoverTrend
                        ? (Number(value) * 100).toFixed(1)
                        : isChange
                          ? Number(value).toFixed(2)
                          : (Number(value) * 100).toFixed(0);
                      return label ? label + ': ' + percent + '%' : percent + '%';
                    }
                  }
                }
              },
              scales: {
                y: {
                  beginAtZero: true,
                  max: 0.5,
                  ticks: {
                    stepSize: 0.01,
                    callback: function(value) {
                      return (value * 100).toFixed(0) + '%';
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
