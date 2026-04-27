import { Router } from 'express';

export function createSignalRouter(db) {
  const router = Router();

  router.get('/', (_req, res) => {
    const latest = latestSignalTime(db);
    if (!latest) {
      res.json({ signal_time: null, rows: [] });
      return;
    }
    const rows = db.queryAll(`
      SELECT ts_code, stock_name, signal_type, score, reason
      FROM signals
      WHERE signal_time = ${db.quote(latest)}
      ORDER BY score DESC
    `);
    res.json({ signal_time: latest, rows });
  });

  router.get('/buy', (_req, res) => {
    const latest = latestSignalTime(db);
    if (!latest) {
      res.json({ signal_time: null, rows: [] });
      return;
    }
    const rows = db.queryAll(`
      SELECT ts_code, stock_name, signal_type, score, reason
      FROM signals
      WHERE signal_time = ${db.quote(latest)}
        AND signal_type = 'BUY_WATCH'
      ORDER BY score DESC
    `);
    res.json({ signal_time: latest, rows });
  });

  return router;
}

function latestSignalTime(db) {
  const row = db.queryOne(`
    SELECT signal_time
    FROM signals
    ORDER BY signal_time DESC
    LIMIT 1
  `);
  return row?.signal_time || null;
}
