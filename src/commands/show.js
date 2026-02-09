import { Command } from 'commander';
import { readDailyFundFlowPayload, normalizeDateInput } from '../services/storeDailyFlow.js';

export const showCommand = new Command('show')
  .argument('<code>', 'stock code')
  .option('-d, --date <date>', 'download date (YYYY-MM-DD or YYYYMMDD)')
  .action((code, options) => {
    const date = normalizeDateInput(options.date);
    try {
      const { rows } = readDailyFundFlowPayload(code, date);

      const table = rows.map((row) => ({
        date: row.date,
        small: row.small,
        medium: row.medium,
        large: row.large,
        extra_large: row.extra_large,
        change_pct: row.change_pct,
        turnover_rate: row.turnover_rate
      }));

      console.table(table);
    } catch (err) {
      process.stderr.write(`Data not found for code ${code}\n`);
      process.exitCode = 1;
    }
  });
