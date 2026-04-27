import { fetchEastmoneyHotRankViaBrowser } from '../eastmoneyBrowserClient.js';

export async function getHotRank(options = {}) {
  const debug = options.debug === true || process.env.HOTRANK_DEBUG === '1';
  const rows = await fetchEastmoneyHotRankViaBrowser({
    pageNo: 1,
    pageSize: Number(options.pageSize) || 100,
    marketType: normalizeMarketType(options.market),
    debug,
  });
  if (debug) {
    process.stdout.write(
      `[hotrank:eastmoney] rows=${rows.length} market=${normalizeMarketType(options.market) || '(all)'}\n`
    );
    if (rows.length > 0) {
      process.stdout.write(`[hotrank:eastmoney] first normalized=${JSON.stringify(rows[0])}\n`);
    }
  }
  return rows;
}

export async function getRiseRank(options = {}) {
  return getHotRank(options);
}

function normalizeMarketType(market) {
  const m = String(market || '').trim().toUpperCase();
  if (m === 'SH' || m === 'SZ') return m;
  return '';
}
