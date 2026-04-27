import express from 'express';
import { getConfig } from './config.js';
import { createSqliteClient, initHotrankSchema } from './db.js';
import { createRankRouter } from './routes/rank.js';
import { createSignalRouter } from './routes/signal.js';

export function createHotrankApp(options = {}) {
  const config = getConfig();
  const db = options.db || createSqliteClient(options.dbPath || config.hotrankDbPath);
  initHotrankSchema(db);

  const app = express();
  app.use(express.json());
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api/rank', createRankRouter(db));
  app.use('/api/signals', createSignalRouter(db));
  return { app, db };
}

export function startHotrankServer(options = {}) {
  const config = getConfig();
  const port = Number(options.port) || config.hotrankApiPort;
  const { app } = createHotrankApp(options);
  return app.listen(port, () => {
    process.stdout.write(`Hotrank API listening on :${port}\n`);
  });
}
