import { Command } from 'commander';
import { fetchDailyFundFlow,normalizeDailyFlow } from '../services/eastmoneyDailyFlow.js';
import { storeDailyFundFlow } from '../services/storeDailyFlow.js';

export const rockCommand = new Command('rock')
  .argument('<code>', 'stock code')
  .action(async (code) => {
    const raw = await fetchDailyFundFlow(code);
    const daily = normalizeDailyFlow(raw);
    const filePath = storeDailyFundFlow(code, daily);

    // 机器友好：只输出 JSON
    process.stdout.write(
      JSON.stringify(
        {
          status: 'ok',
          code,
          days: daily.length,
          output: filePath
        },
        null,
        2
      )
    );
  });
