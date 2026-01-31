// src/providers/index.js
export async function getSmallOrderData(code) {
  // east store
  return import('./eastmoney.js').then(m => m.fetch(code));
}
