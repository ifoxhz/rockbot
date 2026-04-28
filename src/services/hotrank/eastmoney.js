import {
  fetchEastmoneyHotRankViaBrowser,
  fetchEastmoneyHotRankHistoryViaBrowser,
} from '../eastmoneyBrowserClient.js';

export async function getHotRank(options = {}) {
  const debug = options.debug === true || process.env.HOTRANK_DEBUG === '1';
  const backfillDays = Math.max(1, Number.parseInt(String(options.backfillDays || '1'), 10) || 1);
  const backfillTop = Math.max(1, Number.parseInt(String(options.backfillTop || '100'), 10) || 100);
  const rows = await fetchEastmoneyHotRankViaBrowser({
    pageNo: 1,
    pageSize: Number(options.pageSize) || 100,
    marketType: normalizeMarketType(options.market),
    debug,
  });
  const currentRows = rows.slice(0, backfillTop);
  const mergedRows = new Map();

  for (const row of currentRows) {
    const key = `${row.stock_code}|${row.trade_date}`;
    mergedRows.set(key, row);
  }

  if (backfillDays > 1 && currentRows.length > 0) {
    const concurrency = Math.max(
      1,
      Number.parseInt(String(process.env.HOTRANK_EASTMONEY_BACKFILL_CONCURRENCY || '4'), 10) || 4
    );
    const tasks = currentRows.map((row) => async () => {
      const srcCode = toEastmoneySrcSecurityCode(row.stock_code);
      try {
        const historyRows = await fetchEastmoneyHotRankHistoryViaBrowser(srcCode, { debug });
        const picked = historyRows
          .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
          .slice(-backfillDays);
        for (const item of picked) {
          const key = `${row.stock_code}|${item.trade_date}`;
          if (!mergedRows.has(key)) {
            mergedRows.set(key, {
              trade_date: item.trade_date,
              stock_code: row.stock_code,
              stock_name: row.stock_name || '',
              rank_no: item.rank_no,
              rank_type: 'HOT',
              score: Number.isFinite(item.rank_no) ? Math.max(0, 10000 - Number(item.rank_no)) : null,
              price: null,
              pct_chg: null,
            });
          }
        }
        return { stock_code: row.stock_code, ok: true, history_count: picked.length };
      } catch (err) {
        return { stock_code: row.stock_code, ok: false, error: err?.message || String(err) };
      }
    });
    const results = await runWithConcurrency(tasks, concurrency);
    if (debug) {
      const okCount = results.filter((item) => item.ok).length;
      const failCount = results.length - okCount;
      process.stdout.write(
        `[hotrank:eastmoney] backfill_days=${backfillDays} symbols=${tasks.length} success=${okCount} failed=${failCount}\n`
      );
      if (failCount > 0) {
        process.stdout.write(
          `[hotrank:eastmoney] backfill failures=${JSON.stringify(
            results.filter((item) => !item.ok).slice(0, 5)
          )}\n`
        );
      }
    }
  }

  const outRows = [...mergedRows.values()].sort((a, b) => {
    const c = String(a.trade_date).localeCompare(String(b.trade_date));
    if (c !== 0) return c;
    return Number(a.rank_no || 999999) - Number(b.rank_no || 999999);
  });
  if (debug) {
    process.stdout.write(
      `[hotrank:eastmoney] rows=${outRows.length} market=${normalizeMarketType(options.market) || '(all)'} backfill_days=${backfillDays}\n`
    );
    if (outRows.length > 0) {
      process.stdout.write(`[hotrank:eastmoney] first normalized=${JSON.stringify(outRows[0])}\n`);
      process.stdout.write(
        `[hotrank:eastmoney] latest normalized=${JSON.stringify(outRows[outRows.length - 1])}\n`
      );
    }
  }
  return outRows;
}

export async function getRiseRank(options = {}) {
  return getHotRank(options);
}

export async function getHotRankForStock(options = {}) {
  const tsCode = normalizeTsCode(options.tsCode || options.stockCode || options.code || '');
  if (!tsCode) {
    throw new Error('tsCode is required, e.g. 600519.SH');
  }
  const backfillDays = Math.max(1, Number.parseInt(String(options.backfillDays || '25'), 10) || 25);
  const debug = options.debug === true || process.env.HOTRANK_DEBUG === '1';
  const srcCode = toEastmoneySrcSecurityCode(tsCode);
  const historyRows = await fetchEastmoneyHotRankHistoryViaBrowser(srcCode, { debug });
  const picked = historyRows
    .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
    .slice(-backfillDays);

  const rows = picked.map((item) => ({
    trade_date: item.trade_date,
    stock_code: tsCode,
    stock_name: String(options.stockName || '').trim(),
    rank_no: item.rank_no,
    rank_type: 'HOT',
    score: Number.isFinite(item.rank_no) ? Math.max(0, 10000 - Number(item.rank_no)) : null,
    price: null,
    pct_chg: null,
  }));
  if (debug) {
    process.stdout.write(
      `[hotrank:eastmoney] single stock backfill ts_code=${tsCode} days=${backfillDays} rows=${rows.length}\n`
    );
  }
  return rows;
}

function normalizeMarketType(market) {
  const m = String(market || '').trim().toUpperCase();
  if (m === 'SH' || m === 'SZ') return m;
  return '';
}

function normalizeTsCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ)$/.test(s)) return s;
  if (/^(SH|SZ)\d{6}$/.test(s)) {
    return `${s.slice(2)}.${s.slice(0, 2)}`;
  }
  if (/^\d{6}$/.test(s)) {
    return s.startsWith('6') ? `${s}.SH` : `${s}.SZ`;
  }
  return '';
}

function toEastmoneySrcSecurityCode(tsCode) {
  const s = String(tsCode || '').trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ)$/.test(s)) {
    const [code, market] = s.split('.');
    return `${market}${code}`;
  }
  if (/^(SH|SZ)\d{6}$/.test(s)) {
    return s;
  }
  throw new Error(`Invalid tsCode for eastmoney srcSecurityCode: ${tsCode}`);
}

async function runWithConcurrency(tasks, concurrency) {
  const list = Array.isArray(tasks) ? tasks : [];
  const workerCount = Math.max(1, Math.min(concurrency, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      try {
        results[index] = await list[index]();
      } catch (err) {
        results[index] = { ok: false, error: err?.message || String(err) };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
