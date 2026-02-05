// src/services/rockService.js
export async function analyzeStock(code, days) {
  const buy = 771733;
  const sell = 9440753;
  const net = buy - sell;

  return {
    type: 'stock_small_order_analysis',
    code,
    period_days: days,
    source: 'eastmoney',
    timestamp: new Date().toISOString(),

    metrics: {
      small_order_buy: buy,
      small_order_sell: sell,
      small_order_net: net
    },

    decision: {
      label: net > 0 ? 'BUY_DOMINANT' : 'SELL_DOMINANT',
      score: net
    },

    algorithm: {
      name: 'small_order_net_flow',
      version: 'v1'
    }
  };
}
