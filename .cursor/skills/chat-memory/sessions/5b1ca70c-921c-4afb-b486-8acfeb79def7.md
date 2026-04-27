---
checkpoint_at: "2026-04-27T15:38:20+08:00"
git_branch: "main"
repo_module: "rockbot"
transcript_uuid: "5b1ca70c-921c-4afb-b486-8acfeb79def7"
session_title: "hotrank pipeline + eastmoney source"
---

# New Chat Resume Template

**Persisted path (per repo):** `.cursor/skills/chat-memory/sessions/<transcript_uuid>.md`. `CURRENT_SESSION_RESUME.md` mirrors the last checkpoint.

## Goal
- Implement hotrank feature from `doc/hotrank.md` with command-driven collection (`rockbot/rackbot hot`) instead of cron, plus API and visualization support.

## Completed
- Added hotrank pipeline modules: config, sqlite wrapper, tushare source, collector, feature calc, strategy, pipeline orchestrator.
- Added CLI command `hot` and alias binary `rackbot`; added `hot serve` and basic hotrank REST routes.
- Added tests for pipeline and API; `npm test` passes.
- Enhanced showline web service with trend window options (5/10/15/20/25), offset slider, and new JSON APIs.
- Added debug logging across hot pipeline and graceful error output.
- Added Eastmoney hotrank source using Playwright/browser flow and `-s/--source` switch for `hot`.

## Files
- `src/commands/hot.js`
- `src/services/hotrank/pipeline.js`
- `src/services/hotrank/collector.js`
- `src/services/hotrank/tushare.js`
- `src/services/hotrank/eastmoney.js`
- `src/services/eastmoneyBrowserClient.js`
- `src/db.js`
- `src/config.js`
- `src/app.js`
- `src/routes/rank.js`
- `src/routes/signal.js`
- `src/commands/showline-html-server.js`
- `bin/cli.js`
- `package.json`
- `tests/hotrank.test.js`

## Validation
- command: `npm test`
- result: pass (2 tests)
- command: `node ./bin/cli.js hot -s eastmoney --debug`
- result: success, 100 rows inserted into `hot_rank_snapshot`

## Open Items
- Tushare `dc_hot` can hit rate limit (`40203`), so production usage may prefer `-s eastmoney` or add retry/backoff/fallback policy.
- Strategy currently inserted 0 signals on sampled eastmoney run; thresholds may need tuning with real data.

## First Step Now
- If continuing, run `rockbot hot -s eastmoney --debug` and inspect strategy output; then tune selection rules or add fallback data source policy.
