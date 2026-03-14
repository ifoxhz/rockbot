import { Command } from 'commander';
import { readDailyFundFlowPayload, normalizeDateInput } from '../services/storeDailyFlow.js';

const ANSI_YELLOW = '\x1b[33m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_RESET = '\x1b[0m';

export const showCommand = new Command('show')
  .argument('<code>', 'stock code')
  .option('-d, --date <date>', 'download date (YYYY-MM-DD or YYYYMMDD)')
  .action((code, options) => {
    const date = normalizeDateInput(options.date);
    try {
      const { rows } = readDailyFundFlowPayload(code, date);

      const table = rows.map((row) => ({
        date: row.date,
        small_s: calculateSellPercentage(row.small_sell, row.medium_sell, row.large_sell, row.extra_large_sell, 'small'),
        medium_s: calculateSellPercentage(row.small_sell, row.medium_sell, row.large_sell, row.extra_large_sell, 'medium'),
        large_s: calculateSellPercentage(row.small_sell, row.medium_sell, row.large_sell, row.extra_large_sell, 'large'),
        extra_large_s: calculateSellPercentage(row.small_sell, row.medium_sell, row.large_sell, row.extra_large_sell, 'extra_large'),
        small_b: calculateBuyPercentage(row.small_buy, row.medium_buy, row.large_buy, row.extra_large_buy, 'small'),
        medium_b: calculateBuyPercentage(row.small_buy, row.medium_buy, row.large_buy, row.extra_large_buy, 'medium'),
        large_b: calculateBuyPercentage(row.small_buy, row.medium_buy, row.large_buy, row.extra_large_buy, 'large'),
        extra_large_b: calculateBuyPercentage(row.small_buy, row.medium_buy, row.large_buy, row.extra_large_buy, 'extra_large'),
        change_pct: row.change_pct,
        turnover_rate: row.turnover_rate
      }));

      printAlternatingTable(table);
    } catch (err) {
      process.stderr.write(`Data not found for code ${code}\n`);
      process.exitCode = 1;
    }
  });

function calculateSellPercentage(smallSell, mediumSell, largeSell, extraLargeSell, size) {
  const small = Number(smallSell) || 0;
  const medium = Number(mediumSell) || 0;
  const large = Number(largeSell) || 0;
  const extraLarge = Number(extraLargeSell) || 0;
  const total = small + medium + large + extraLarge;

  if (total === 0) return '0.00%';

  let value = 0;
  if (size === 'small') value = small;
  else if (size === 'medium') value = medium;
  else if (size === 'large') value = large;
  else if (size === 'extra_large') value = extraLarge;

  const percentage = (value / total) * 100;
  return `${percentage.toFixed(2)}%`;
}

function calculateBuyPercentage(smallBuy, mediumBuy, largeBuy, extraLargeBuy, size) {
  const small = Number(smallBuy) || 0;
  const medium = Number(mediumBuy) || 0;
  const large = Number(largeBuy) || 0;
  const extraLarge = Number(extraLargeBuy) || 0;
  const total = small + medium + large + extraLarge;

  if (total === 0) return '0.00%';

  let value = 0;
  if (size === 'small') value = small;
  else if (size === 'medium') value = medium;
  else if (size === 'large') value = large;
  else if (size === 'extra_large') value = extraLarge;

  const percentage = (value / total) * 100;
  return `${percentage.toFixed(2)}%`;
}

function printAlternatingTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    process.stdout.write('(no data)\n');
    return;
  }

  const columns = Object.keys(rows[0]);
  const widths = {};

  for (const col of columns) {
    widths[col] = col.length;
  }

  for (const row of rows) {
    for (const col of columns) {
      const value = stringifyCell(row[col]);
      if (value.length > widths[col]) {
        widths[col] = value.length;
      }
    }
  }

  const header = columns.map((col) => pad(col, widths[col])).join(' | ');
  const separator = columns.map((col) => '-'.repeat(widths[col])).join('-+-');
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${separator}\n`);

  for (let i = 0; i < rows.length; i++) {
    const line = columns
      .map((col) => pad(stringifyCell(rows[i][col]), widths[col]))
      .join(' | ');
    const color = i % 2 === 0 ? ANSI_YELLOW : ANSI_GREEN;
    process.stdout.write(`${color}${line}${ANSI_RESET}\n`);
  }
}

function stringifyCell(value) {
  if (value == null) return '';
  return String(value);
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}
