// Load .env before other app modules read process.env.
// - Same path (cwd == repo): load once with override.
// - Different paths: load repo .env first, then cwd .env (local overrides). This avoids an empty
//   or unrelated cwd .env blocking the real project .env (the old "injecting env (0)" issue).
// - override: true so file values win over empty shell-preset vars (dotenv would otherwise inject 0).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const cwdEnv = path.resolve(process.cwd(), '.env');
const repoEnv = path.resolve(path.join(repoRoot, '.env'));

if (cwdEnv === repoEnv) {
  if (fs.existsSync(cwdEnv)) {
    dotenvConfig({ path: cwdEnv, override: true });
  }
} else {
  if (fs.existsSync(repoEnv)) {
    dotenvConfig({ path: repoEnv, override: true });
  }
  if (fs.existsSync(cwdEnv)) {
    dotenvConfig({ path: cwdEnv, override: true });
  }
}
