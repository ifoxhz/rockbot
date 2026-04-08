#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { fetchEastmoneyDailyKlinesViaBrowser, closeEastmoneyBrowser } from '../src/services/eastmoneyBrowserClient.js';

const code = process.argv[2] || '601179';
const days = Math.max(1, Number.parseInt(String(process.argv[3] || '25'), 10) || 25);
const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;

try {
  const rows = await fetchEastmoneyDailyKlinesViaBrowser(secid, days);
  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        secid,
        days,
        ok: true,
        count: rows.length,
        first: rows[0] || null,
        last: rows[rows.length - 1] || null,
      },
      null,
      2
    )}\n`
  );
} catch (err) {
  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        secid,
        days,
        ok: false,
        name: err?.name,
        message: err?.message,
      },
      null,
      2
    )}\n`
  );
} finally {
  await closeEastmoneyBrowser();
}
