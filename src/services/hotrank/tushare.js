import { getConfig } from '../../config.js';

export async function getHotRank(options = {}) {
  const config = getConfig();
  const debug = options.debug === true || process.env.HOTRANK_DEBUG === '1';
  if (!config.tushareToken) {
    throw new Error('TUSHARE_TOKEN is required');
  }

  const params = {
    market: options.market || config.hotrankMarket || 'A',
  };
  const inputTradeDate = options.tradeDate ? normalizeTradeDate(options.tradeDate) : null;
  if (options.tradeDate) {
    params.trade_date = formatTradeDateCompact(options.tradeDate);
  }

  let rows = await tushareRequest({
    apiName: 'dc_hot',
    params,
    fields: '',
    apiUrl: config.tushareApiUrl,
    token: config.tushareToken,
    debug,
  });
  let resolvedTradeDate = inputTradeDate;

  if (!inputTradeDate && rows.length === 0) {
    const fallbackDates = recentCompactDates(10);
    for (const compactDate of fallbackDates) {
      if (debug) {
        process.stdout.write(
          `[hotrank:tushare] empty result, retry with trade_date=${compactDate}\n`
        );
      }
      rows = await tushareRequest({
        apiName: 'dc_hot',
        params: {
          market: options.market || config.hotrankMarket || 'A',
          trade_date: compactDate,
        },
        fields: '',
        apiUrl: config.tushareApiUrl,
        token: config.tushareToken,
        debug,
      });
      if (rows.length > 0) {
        resolvedTradeDate = normalizeTradeDate(compactDate);
        if (debug) {
          process.stdout.write(
            `[hotrank:tushare] fallback hit trade_date=${compactDate} items=${rows.length}\n`
          );
        }
        break;
      }
    }
  }

  const normalized = rows.map((row) => normalizeHotRankRow(row, resolvedTradeDate || options.tradeDate));
  if (debug) {
    process.stdout.write(
      `[hotrank:tushare] normalized rows=${normalized.length} emptyCode=${normalized.filter((row) => !row.stock_code).length}\n`
    );
    if (normalized.length > 0) {
      process.stdout.write(`[hotrank:tushare] first normalized=${JSON.stringify(normalized[0])}\n`);
    }
  }
  return normalized;
}

export async function getRiseRank(options = {}) {
  const config = getConfig();
  if (!config.tushareToken) {
    throw new Error('TUSHARE_TOKEN is required');
  }
  const params = {
    market: options.market || config.hotrankMarket || 'A',
  };
  if (options.tradeDate) {
    params.trade_date = formatTradeDateCompact(options.tradeDate);
  }

  const rows = await tushareRequest({
    apiName: 'dc_hot',
    params,
    fields: '',
    apiUrl: config.tushareApiUrl,
    token: config.tushareToken,
  });
  return rows.map((row) => normalizeHotRankRow(row, options.tradeDate));
}

async function tushareRequest({ apiName, params, fields, apiUrl, token, debug = false }) {
  if (debug) {
    process.stdout.write(
      `[hotrank:tushare] request api=${apiName} url=${apiUrl} params=${JSON.stringify(params)}\n`
    );
  }
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_name: apiName,
      token,
      params,
      fields,
    }),
  });
  if (!res.ok) {
    throw new Error(`Tushare HTTP error: ${res.status}`);
  }
  const json = await res.json();
  if (debug) {
    process.stdout.write(
      `[hotrank:tushare] response code=${json?.code} msg=${json?.msg || ''}\n`
    );
  }
  if (json?.code !== 0) {
    throw new Error(json?.msg || 'Tushare returned error');
  }
  const cols = Array.isArray(json?.data?.fields) ? json.data.fields : [];
  const items = Array.isArray(json?.data?.items) ? json.data.items : [];
  if (debug) {
    process.stdout.write(
      `[hotrank:tushare] fields=${JSON.stringify(cols)} items=${items.length}\n`
    );
    if (items.length > 0) {
      process.stdout.write(`[hotrank:tushare] first raw item=${JSON.stringify(items[0])}\n`);
    }
  }
  return items.map((item) => {
    const row = {};
    for (let i = 0; i < cols.length; i += 1) {
      row[cols[i]] = item[i];
    }
    return row;
  });
}

function normalizeHotRankRow(row, inputTradeDate) {
  const codeRaw =
    row.ts_code || row.stock_code || row.code || row.symbol || row.stock || row.con_code || '';
  const tsCode = normalizeTsCode(codeRaw);
  return {
    trade_date: normalizeTradeDate(row.trade_date || inputTradeDate || new Date()),
    stock_code: tsCode,
    stock_name: String(row.name || row.stock_name || row.ts_name || '').trim(),
    rank_no: toFinite(row.rank || row.rank_no || row.hot_rank || row.ranking),
    rank_type: String(row.rank_type || row.type || 'HOT').trim() || 'HOT',
    score: toFinite(row.score || row.heat || row.hot || row.hot_score),
    price: toFinite(row.price || row.current_price || row.close || row.latest || row.last),
    pct_chg: toFinite(row.pct_chg || row.pct_change || row.change_pct || row.change_percent || row.pct),
  };
}

function normalizeTsCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  if (/^\d{6}\.(SZ|SH)$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) {
    return s.startsWith('6') ? `${s}.SH` : `${s}.SZ`;
  }
  return s;
}

function normalizeTradeDate(value) {
  if (value instanceof Date) {
    return formatDate(value);
  }
  const s = String(value || '').trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return formatDate(new Date());
}

function formatTradeDateCompact(value) {
  const s = normalizeTradeDate(value);
  return s.replaceAll('-', '');
}

function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function recentCompactDates(days = 10) {
  const n = Math.max(1, Number(days) || 10);
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i += 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    out.push(formatDate(date).replaceAll('-', ''));
  }
  return out;
}
