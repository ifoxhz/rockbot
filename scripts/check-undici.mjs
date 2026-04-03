#!/usr/bin/env node
/**
 * Prints whether this Node binary exposes `node:undici` and whether npm `undici` resolves.
 * Run: node scripts/check-undici.mjs
 */

const v = process.version;
process.stdout.write(`Node ${v}\n`);

let nodeUndici = 'not tried';
try {
  const m = await import('node:undici');
  nodeUndici = m?.Agent && m?.fetch ? 'ok (Agent + fetch)' : `partial keys=${Object.keys(m || {}).slice(0, 8)}`;
} catch (e) {
  nodeUndici = `fail: ${e.code || e.name} — ${e.message}`;
}
process.stdout.write(`import('node:undici'): ${nodeUndici}\n`);

let npmUndici = 'not tried';
try {
  const m = await import('undici');
  npmUndici = m?.Agent && m?.fetch ? 'ok (Agent + fetch)' : `partial keys=${Object.keys(m || {}).slice(0, 8)}`;
} catch (e) {
  npmUndici = `fail: ${e.code || e.name} — ${e.message}`;
}
process.stdout.write(`import('undici'):       ${npmUndici}\n`);

process.stdout.write(
  typeof globalThis.fetch === 'function'
    ? 'globalThis.fetch:     available\n'
    : 'globalThis.fetch:     missing\n'
);
