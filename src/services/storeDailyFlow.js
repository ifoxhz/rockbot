import fs from 'fs';
import path from 'path';

const DAILY_BASE_DIR = path.resolve('data/daily_fund_flow');
const ANALYSIS_BASE_DIR = path.resolve('data/analysis');

export function storeDailyFundFlow(code, dailyData, options = {}) {
  const date = normalizeDateInput(options.date) || todayDate();
  const dir = path.join(DAILY_BASE_DIR, date);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${code}.json`);

  const payload = {
    code,
    unit: 'million_cny',
    source: 'eastmoney',
    algorithm_version: 'daily_fund_flow_v1',
    generated_at: new Date().toISOString(),
    download_date: date,
    data: dailyData
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');

  return filePath;
}

export function checkSmallNetBuyDays(code, minDays = 5, options = {}) {
  const { rows } = readDailyFundFlowPayload(code, options.date);

  const positiveDates = rows
    .filter((row) => Number(row.small) > 0)
    .map((row) => row.date);

  return {
    code,
    total_days: rows.length,
    positive_days: positiveDates.length,
    min_days: minDays,
    meets_requirement: positiveDates.length >= minDays,
    positive_dates: positiveDates
  };
}

export function applyStockFilters(code, filters = [], options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : readDailyFundFlow(code, options.date);
  const ctx = { code, rows };

  const outputs = {};
  let passed = true;
  if (Array.isArray(filters) && filters.length > 0) {
    for (const fn of filters) {
      const result = safeFilter(fn, ctx);
      if (!result.pass) {
        passed = false;
        break;
      }
      if (result.output && typeof result.output === 'object') {
        Object.assign(outputs, result.output);
      }
    }
  }

  return {
    code,
    total_days: rows.length,
    passed,
    outputs
  };
}

// Hook / filter: returns a function that checks streak with row-level filters
export function checkSmallNetBuyStreak(minDays = 5, rowFilters = defaultRowFilters()) {
  return (ctx) => {
    const rows = Array.isArray(ctx?.rows) ? ctx.rows : [];
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

    let maxStreak = 0;
    let currentStreak = 0;

    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      const isConsecutiveTradingDay = i > 0; // adjacency in data = consecutive trading day
      const meetsAll = applyRowFilters(rowFilters, row);

      if (meetsAll) {
        if (currentStreak === 0) {
          currentStreak = 1;
        } else if (isConsecutiveTradingDay) {
          currentStreak += 1;
        } else {
          currentStreak = 1;
        }
      } else {
        currentStreak = 0;
      }

      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
      }
    }

    return {
      pass: maxStreak >= minDays,
      output: {
        max_streak: maxStreak,
        min_days: minDays
      }
    };
  };
}

// Hook / filter: computes stddev of daily change_pct
export function changePctStddev(min = 1.2, max = 1.62) {
  return (ctx) => {
    const rows = Array.isArray(ctx?.rows) ? ctx.rows : [];
    const values = rows
      .map((row) => Number(row.change_pct))
      .filter((v) => Number.isFinite(v));

    const stddev = calculateStddev(values);
    return stddev != null && stddev > min && stddev < max;
  };
}

// Hook / filter: rising days > falling days
export function risingDaysGreater() {
  return (ctx) => {
    const rows = Array.isArray(ctx?.rows) ? ctx.rows : [];
    let up = 0;
    let down = 0;
    for (const row of rows) {
      const v = Number(row.change_pct);
      if (!Number.isFinite(v)) continue;
      if (v >= 0) up += 1;
      if (v < 0) down += 1;
    }
    return up > down;
  };
}

export function defaultRowFilters() {
  return [
    (row) => Number(row.small) > 0,
    (row) => row.change_pct != null && Number(row.change_pct) >= -1.8,
  ];
}

export function readDailyFundFlow(code, date) {
  const { rows } = readDailyFundFlowPayload(code, date);
  return rows;
}

export function readDailyFundFlowPayload(code, date) {
  const { filePath } = resolveDailyFundFlowPath(code, date);
  if (!filePath) {
    throw new Error(`Daily fund flow data not found for code ${code}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const payload = JSON.parse(raw);
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return { filePath, payload, rows };
}

export function listDailyFundFlowFiles(date) {
  const normalized = normalizeDateInput(date);
  if (!normalized) {
    throw new Error('Invalid date format. Use YYYY-MM-DD or YYYYMMDD.');
  }
  const dir = path.join(DAILY_BASE_DIR, normalized);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((ent) => ent.isFile() && ent.name.endsWith('.json'))
    .map((ent) => ({
      code: ent.name.replace(/\.json$/, ''),
      filePath: path.join(dir, ent.name)
    }));
}

export function storeDailyAnalysisFile(payload, options = {}) {
  const date = normalizeDateInput(options.date) || todayDate();
  fs.mkdirSync(ANALYSIS_BASE_DIR, { recursive: true });

  const filePath = path.join(ANALYSIS_BASE_DIR, `${date}.json`);
  const body = {
    analysis_date: date,
    generated_at: new Date().toISOString(),
    ...payload
  };
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2), 'utf-8');
  return filePath;
}

function applyRowFilters(filters, row) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  return filters.every((fn) => {
    try {
      return fn(row) === true;
    } catch {
      return false;
    }
  });
}

function safeFilter(fn, ctx) {
  try {
    const result = fn(ctx);
    if (typeof result === 'boolean') {
      return { pass: result, output: null };
    }
    if (result && typeof result === 'object') {
      return {
        pass: result.pass !== false,
        output: result.output ?? null
      };
    }
    return { pass: true, output: null };
  } catch {
    return { pass: false, output: null };
  }
}

function calculateStddev(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Number(Math.sqrt(variance).toFixed(4));
}

export function normalizeDateInput(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }
  return null;
}

export function todayDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function resolveDailyFundFlowPath(code, date) {
  const normalized = normalizeDateInput(date);
  if (normalized) {
    const dated = path.join(DAILY_BASE_DIR, normalized, `${code}.json`);
    if (fs.existsSync(dated)) {
      return { filePath: dated, date: normalized };
    }
  }

  const latest = findLatestDateDir();
  if (latest) {
    const latestPath = path.join(DAILY_BASE_DIR, latest, `${code}.json`);
    if (fs.existsSync(latestPath)) {
      return { filePath: latestPath, date: latest };
    }
  }

  const legacyPath = path.join(DAILY_BASE_DIR, `${code}.json`);
  if (fs.existsSync(legacyPath)) {
    return { filePath: legacyPath, date: null };
  }

  return { filePath: null, date: null };
}

function findLatestDateDir() {
  if (!fs.existsSync(DAILY_BASE_DIR)) return null;
  const entries = fs.readdirSync(DAILY_BASE_DIR, { withFileTypes: true });
  const dates = entries
    .filter((ent) => ent.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(ent.name))
    .map((ent) => ent.name)
    .sort();
  if (dates.length === 0) return null;
  return dates[dates.length - 1];
}
