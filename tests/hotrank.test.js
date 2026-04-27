import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSqliteClient, initHotrankSchema } from '../src/db.js';
import { collectHotrankSnapshot } from '../src/services/hotrank/collector.js';
import { computeHotFeatures } from '../src/services/hotrank/feature.js';
import { runHotStrategies } from '../src/services/hotrank/strategy.js';
import { createHotrankApp } from '../src/app.js';

test('hotrank pipeline computes features and emits BUY_WATCH signal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockbot-hotrank-'));
  const dbPath = path.join(tempDir, 'hotrank.db');
  const db = createSqliteClient(dbPath);
  initHotrankSchema(db);

  const snapshots = [
    { captureTime: '2026-04-27T09:30:00.000Z', rank: 45, score: 12 },
    { captureTime: '2026-04-27T10:30:00.000Z', rank: 34, score: 18 },
    { captureTime: '2026-04-27T11:30:00.000Z', rank: 26, score: 30 },
  ];

  for (const item of snapshots) {
    await collectHotrankSnapshot({
      db,
      tradeDate: '2026-04-27',
      captureTime: item.captureTime,
      fetcher: async () => [
        {
          trade_date: '2026-04-27',
          stock_code: '000001.SZ',
          stock_name: '平安银行',
          rank_no: item.rank,
          rank_type: 'HOT',
          score: item.score,
          price: 12.34,
          pct_chg: 2.5,
        },
      ],
    });
  }

  const featureResult = computeHotFeatures({
    db,
    tradeDate: '2026-04-27',
    calcTime: '2026-04-27T11:31:00.000Z',
  });
  assert.equal(featureResult.inserted, 1);

  const strategyResult = runHotStrategies({
    db,
    tradeDate: '2026-04-27',
    signalTime: '2026-04-27T11:32:00.000Z',
    bigRisePct: 8,
  });
  assert.equal(strategyResult.inserted, 1);
  assert.equal(strategyResult.signals[0].signal_type, 'BUY_WATCH');
  assert.equal(strategyResult.signals[0].ts_code, '000001.SZ');
});

test('hotrank API returns latest buy signals', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockbot-hotrank-api-'));
  const dbPath = path.join(tempDir, 'hotrank.db');
  const db = createSqliteClient(dbPath);
  initHotrankSchema(db);

  db.run(`
    INSERT INTO signals (signal_time, ts_code, stock_name, signal_type, score, reason)
    VALUES
      ('2026-04-27T12:00:00.000Z', '000001.SZ', '平安银行', 'BUY_WATCH', 12.2, 'test'),
      ('2026-04-27T12:00:00.000Z', '000002.SZ', '万 科A', 'OVERHEAT', 8.1, 'test');
  `);

  const { app } = createHotrankApp({ db });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/signals/buy`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Array.isArray(payload.rows), true);
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].ts_code, '000001.SZ');

  server.close();
});
