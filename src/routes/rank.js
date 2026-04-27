import { Router } from 'express';

export function createRankRouter(db) {
  const router = Router();

  router.get('/today', (_req, res) => {
    const latest = db.queryOne(`
      SELECT trade_date, capture_time
      FROM hot_rank_snapshot
      ORDER BY capture_time DESC
      LIMIT 1
    `);
    if (!latest) {
      res.json({ trade_date: null, capture_time: null, rows: [] });
      return;
    }

    const rows = db.queryAll(`
      SELECT stock_code, stock_name, rank_no, rank_type, score, price, pct_chg
      FROM hot_rank_snapshot
      WHERE trade_date = ${db.quote(latest.trade_date)}
        AND capture_time = ${db.quote(latest.capture_time)}
      ORDER BY rank_no ASC
    `);
    res.json({
      trade_date: latest.trade_date,
      capture_time: latest.capture_time,
      rows,
    });
  });

  router.get('/history/:tsCode', (req, res) => {
    const tsCode = String(req.params.tsCode || '').toUpperCase();
    const rows = db.queryAll(`
      SELECT trade_date, capture_time, stock_code, stock_name, rank_no, score, price, pct_chg
      FROM hot_rank_snapshot
      WHERE stock_code = ${db.quote(tsCode)}
      ORDER BY capture_time DESC
      LIMIT 200
    `);
    res.json({ ts_code: tsCode, rows });
  });

  return router;
}
