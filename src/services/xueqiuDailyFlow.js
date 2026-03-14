// src/services/xueqiuMoneyflow.js

import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const BASE = "https://stock.xueqiu.com";

/**
 * 构造完整 Cookie
 */
function buildHeaders() {
  const {
    xq_a_token,
    xq_r_token,
    xq_id_token,
    xqat,
  } = process.env;

  if (!xq_a_token) {
    throw new Error("Missing xq_a_token in .env");
  }

  const cookie = [
    `xq_a_token=${xq_a_token}`,
    xq_r_token && `xq_r_token=${xq_r_token}`,
    xq_id_token && `xq_id_token=${xq_id_token}`,
    xqat && `xqat=${xqat}`,
  ]
    .filter(Boolean)
    .join("; ");

  return {
    Cookie: cookie,
    Referer: "https://xueqiu.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "application/json, text/plain, */*",
  };
}

/**
 * 股票代码转换
 */
function normalizeSymbol(code) {
  if (code.startsWith("6")) return `SH${code}`;
  return `SZ${code}`;
}

/**
 * 日期格式
 */
function formatDate(ts) {
  const d = new Date(ts);

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 主函数
 */
export async function fetchDailyFundFlow(code, days = 15) {
  const symbol = normalizeSymbol(code);

  // ⚠️ 需要抓包确认这个接口
  const url =
    `${BASE}/v5/stock/moneyflow/day.json` +
    `?symbol=${symbol}` +
    `&count=${days}`;

  const headers = buildHeaders();

  console.log("===== Xueqiu Debug =====");
  console.log("URL:", url);
  console.log("Headers:", headers);

  const res = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = await res.json();

  console.log(
    "Response:",
    JSON.stringify(json, null, 2)
  );

  if (!json?.data) {
    console.warn("No data field");
    return [];
  }

  const items =
    json.data.items ||
    json.data.item ||
    json.data;

  if (!Array.isArray(items)) {
    console.warn("Items not array");
    return [];
  }

  return items.map((row) => ({
    date: formatDate(
      row.timestamp ||
        row.trade_date ||
        Date.now()
    ),

    small: row.sm_net || 0,
    small_buy: row.buy_sm_amount || 0,
    small_sell: row.sell_sm_amount || 0,

    medium: row.md_net || 0,
    medium_buy: row.buy_md_amount || 0,
    medium_sell: row.sell_md_amount || 0,

    large: row.lg_net || 0,
    large_buy: row.buy_lg_amount || 0,
    large_sell: row.sell_lg_amount || 0,

    extra_large: row.elg_net || 0,
    extra_large_buy: row.buy_elg_amount || 0,
    extra_large_sell: row.sell_elg_amount || 0,

    change_pct:
      row.percent ||
      row.pct_chg ||
      null,

    turnover_rate:
      row.turnoverrate ||
      row.turnover_rate ||
      null,

    unit: "million",
    currency: "CNY",
    source: "xueqiu",
  }));
}

/**
 * 调试函数
 */
export async function debugFetch(code) {
  const data =
    await fetchDailyFundFlow(code, 10);

  console.log(
    "Processed:",
    JSON.stringify(data, null, 2)
  );
}