import path from 'node:path';

const DEFAULT_HOTRANK_DB_PATH = path.resolve('data/hotrank.db');
const DEFAULT_TUSHARE_API_URL = 'https://api.tushare.pro';

export function getConfig() {
  return {
    tushareToken: String(process.env.TUSHARE_TOKEN || '').trim(),
    tushareApiUrl: String(process.env.TUSHARE_API_URL || DEFAULT_TUSHARE_API_URL).trim(),
    hotrankDbPath: path.resolve(process.env.DB_PATH || DEFAULT_HOTRANK_DB_PATH),
    hotrankMarket: String(process.env.HOTRANK_MARKET || 'A').trim() || 'A',
    hotrankBigRisePct: toFinite(process.env.HOTRANK_BIG_RISE_PCT, 9.8),
    hotrankApiPort: toFinite(process.env.HOTRANK_API_PORT, 3099),
  };
}

function toFinite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
