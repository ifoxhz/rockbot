/**
 * ⚠️ 第一版：模拟东方财富返回结构
 * 后续你只需要把这里换成真实 fetch
 */
export async function fetchSmallOrderLastMonth(code) {
  // 模拟网络延迟
  await new Promise(r => setTimeout(r, 300));

  // 模拟数据（结构是真实世界友好的）
  const buy = Math.floor(Math.random() * 1e7);
  const sell = Math.floor(Math.random() * 1e7);

  return {
    buy,
    sell,
    net: buy - sell,
    unit: 'shares',
    days: 30
  };
}

