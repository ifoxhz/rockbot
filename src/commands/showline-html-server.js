import express from 'express';
import { readDailyFundFlowPayload, normalizeDateInput } from '../services/storeDailyFlow.js';

export function startShowlineServer({ port = 7070 } = {}) {
  const app = express();

  app.get('/showline/:code', (req, res) => {
    const code = req.params.code;
    const date = normalizeDateInput(req.query.date);

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
      const maxAbsChange = changePctValues.length > 0
        ? changePctValues.reduce((max, v) => Math.max(max, Math.abs(v)), 0)
        : 5;

      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${code} Fund Flow</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      </head>
      <body>
        <h2>${code} \u8d85\u5927\u5355\u4e70\u5356\u6bd4\u4f8b\u8d8b\u52bf</h2>
        <canvas id="chart" width="670" height="400"></canvas>
        <script>
          const ctx = document.getElementById('chart').getContext('2d');
          const LABEL_BUY = '\\u4e70\\u5165\\u5360\\u6bd4';
          const LABEL_SELL = '\\u5356\\u51fa\\u5360\\u6bd4';
          const LABEL_TURNOVER = '\\u6362\\u624b\\u7387';
          const LABEL_CHANGE = '\\u6da8\\u8dcc\\u5e45';
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
                  label: LABEL_SELL,
                  data: ${JSON.stringify(sell)},
                  borderColor: 'red',
                  backgroundColor: 'rgba(255,0,0,0.1)',
                  fill: false,
                  tension: 0.2,
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
                      const isChange = context.dataset?.label === LABEL_CHANGE;
                      const percent = isTurnover
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
                  max: 1,
                  ticks: {
                    stepSize: 0.02,
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
                  grid: { drawOnChartArea: false },
                  ticks: {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  startShowlineServer();
}







