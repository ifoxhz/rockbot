import { Command } from 'commander';
import {
  listDailyFundFlowFiles,
  readDailyFundFlowPayload,
  runStockAnalysis,
  storeDailyAnalysisFile,
  normalizeDateInput,
  getDefaultAnalysisConfig
} from '../services/storeDailyFlow.js';

const DEFAULT_MIN_TURNOVER = getDefaultAnalysisConfig().minTurnover;

export const reanalyzeCommand = new Command('reanalyze')
  .argument('<date>', 'download date (YYYY-MM-DD or YYYYMMDD)')
  .option('-m, --min-turnover <value>', 'minimum average turnover rate', String(DEFAULT_MIN_TURNOVER))
  .action((dateInput, options) => {
    const date = normalizeDateInput(dateInput);
    if (!date) {
      process.stderr.write('Invalid date format. Use YYYY-MM-DD or YYYYMMDD.\n');
      process.exitCode = 1;
      return;
    }
    const minTurnover = Number(options.minTurnover);
    if (!Number.isFinite(minTurnover)) {
      process.stderr.write('Invalid --min-turnover value\n');
      process.exitCode = 1;
      return;
    }

    const files = listDailyFundFlowFiles(date);
    if (files.length === 0) {
      process.stderr.write(`No downloaded data found for ${date}\n`);
      process.exitCode = 1;
      return;
    }

    const matched = [];
    const errors = [];
    const analysisResults = [];

    for (const { code, filePath } of files) {
      try {
        const { rows } = readDailyFundFlowPayload(code, date);
        const check = runStockAnalysis(code, { rows, date, minTurnover });

        if (check.passed) {
          matched.push(code);
        }
        analysisResults.push({
          code,
          ...check,
          source_file: filePath
        });
      } catch (err) {
        errors.push({ code, error: err?.message || String(err) });
      }
    }

    storeDailyAnalysisFile(
      {
        source: 'reanalyze',
        min_turnover: minTurnover,
        total: files.length,
        matched_count: matched.length,
        matched_codes: matched,
        results: analysisResults,
        errors
      },
      { date }
    );

    process.stdout.write(
      JSON.stringify(
        {
          status: 'ok',
          total: files.length,
          matched_count: matched.length,
          matched_codes: matched,
          analysis_date: date,
          min_turnover: minTurnover
        },
        null,
        2
      )
    );

    if (errors.length > 0) {
      process.stderr.write(
        JSON.stringify(
          {
            status: 'error',
            errors
          },
          null,
          2
        )
      );
    }
  });
