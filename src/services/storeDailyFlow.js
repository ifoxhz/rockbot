import fs from 'fs';
import path from 'path';

export function storeDailyFundFlow(code, dailyData) {
  const dir = path.resolve('data/daily_fund_flow');
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${code}.json`);

  const payload = {
    code,
    unit: 'million_cny',
    source: 'eastmoney',
    algorithm_version: 'daily_fund_flow_v1',
    generated_at: new Date().toISOString(),
    data: dailyData
  };

  fs.writeFileSync(
    filePath,
    JSON.stringify(payload, null, 2),
    'utf-8'
  );

  return filePath;
}

