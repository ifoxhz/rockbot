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
      const { payload } = readDailyFundFlowPayload(code, date);
      const table = Array.isArray(payload?.data) ? payload.data : [];

      printAlternatingTable(table);
    } catch (err) {
      process.stderr.write(`Data not found for code ${code}\n`);
      process.exitCode = 1;
    }
  });

function printAlternatingTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    process.stdout.write('(no data)\n');
    return;
  }

  const columns = collectColumns(rows);
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

function collectColumns(rows) {
  const preferred = [
    'date',
    'main_net',
    'small',
    'medium',
    'large',
    'extra_large',
    'change_pct',
    'turnover_rate',
  ];
  const set = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      set.add(key);
    }
  }
  return preferred.filter((key) => set.has(key));
}

function stringifyCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(3).replace(/\.?0+$/, '');
  }
  return String(value);
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}
