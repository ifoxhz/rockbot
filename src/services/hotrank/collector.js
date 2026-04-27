import { getHotRank } from './tushare.js';

export async function collectHotrankSnapshot({ db, tradeDate, captureTime, market, fetcher } = {}) {
  const runCaptureTime = captureTime || new Date().toISOString();
  const loadRows = typeof fetcher === 'function' ? fetcher : getHotRank;
  const rows = await loadRows({ tradeDate, market });
  const validRows = rows
    .filter((row) => row && row.stock_code)
    .map((row) => ({
      trade_date: row.trade_date || tradeDate || todayDate(),
      capture_time: runCaptureTime,
      stock_code: row.stock_code,
      stock_name: row.stock_name || '',
      rank_no: row.rank_no,
      rank_type: row.rank_type || 'HOT',
      score: row.score,
      price: row.price,
      pct_chg: row.pct_chg,
    }));

  if (validRows.length === 0) {
    return { captureTime: runCaptureTime, tradeDate: tradeDate || todayDate(), inserted: 0, total: 0 };
  }

  const statements = validRows.map((row) => {
    return `
      INSERT INTO hot_rank_snapshot (
        trade_date, capture_time, stock_code, stock_name, rank_no, rank_type, score, price, pct_chg
      ) VALUES (
        ${db.quote(row.trade_date)},
        ${db.quote(row.capture_time)},
        ${db.quote(row.stock_code)},
        ${db.quote(row.stock_name)},
        ${db.quote(row.rank_no)},
        ${db.quote(row.rank_type)},
        ${db.quote(row.score)},
        ${db.quote(row.price)},
        ${db.quote(row.pct_chg)}
      )
    `;
  });
  db.transaction(statements);
  return {
    captureTime: runCaptureTime,
    tradeDate: validRows[0].trade_date,
    inserted: validRows.length,
    total: validRows.length,
  };
}

function todayDate() {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
