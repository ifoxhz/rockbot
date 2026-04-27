import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function createSqliteClient(dbPath) {
  const filePath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  return {
    filePath,
    run(sql) {
      execSqlite(filePath, sql);
    },
    queryAll(sql) {
      const output = execSqlite(filePath, sql, { json: true });
      if (!output.trim()) return [];
      try {
        const parsed = JSON.parse(output);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    queryOne(sql) {
      return this.queryAll(sql)[0] || null;
    },
    transaction(statements) {
      const list = Array.isArray(statements) ? statements : [];
      if (list.length === 0) return;
      const chunkSize = 200;
      for (let i = 0; i < list.length; i += chunkSize) {
        const chunk = list.slice(i, i + chunkSize);
        const script = ['BEGIN;'];
        for (const statement of chunk) {
          if (statement) {
            script.push(statement.endsWith(';') ? statement : `${statement};`);
          }
        }
        script.push('COMMIT;');
        execSqlite(filePath, script.join('\n'));
      }
    },
    quote(value) {
      return quoteSql(value);
    },
  };
}

export function initHotrankSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS hot_rank_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date TEXT NOT NULL,
      capture_time TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_name TEXT,
      rank_no INTEGER,
      rank_type TEXT DEFAULT 'HOT',
      score REAL,
      price REAL,
      pct_chg REAL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS hot_features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_code TEXT NOT NULL,
      calc_time TEXT NOT NULL,
      rank_now INTEGER,
      rank_prev INTEGER,
      heat_speed REAL,
      appear_7d INTEGER,
      top10_30d INTEGER
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_time TEXT NOT NULL,
      ts_code TEXT NOT NULL,
      stock_name TEXT,
      signal_type TEXT NOT NULL,
      score REAL,
      reason TEXT
    );
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_hot_rank_snapshot_code_time
    ON hot_rank_snapshot(stock_code, capture_time);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_hot_rank_snapshot_trade_date
    ON hot_rank_snapshot(trade_date);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_hot_features_calc_time
    ON hot_features(calc_time);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_signals_time_type
    ON signals(signal_time, signal_type);
  `);
}

function execSqlite(dbPath, sql, options = {}) {
  const args = [dbPath];
  if (options.json) {
    args.push('-cmd', '.mode json');
  }
  args.push(sql);
  return execFileSync('sqlite3', args, { encoding: 'utf8' });
}

function quoteSql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  const s = String(value).replaceAll("'", "''");
  return `'${s}'`;
}
