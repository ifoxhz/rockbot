import fs from 'fs';
import path from 'path';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function saveRecord(code, record) {
  const baseDir = path.resolve('data/stocks', code);
  ensureDir(baseDir);

  const file = path.join(baseDir, `${record.fetchedAt.slice(0, 7)}.jsonl`);

  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

