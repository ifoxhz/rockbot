#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { fetchRealtimeQuote } from '../src/services/eastmoneyDailyFlow.js';
import { closeEastmoneyBrowser } from '../src/services/eastmoneyBrowserClient.js';

const code = process.argv[2] || '601179';

try {
  const data = await fetchRealtimeQuote(code);
  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        ok: true,
        data,
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
