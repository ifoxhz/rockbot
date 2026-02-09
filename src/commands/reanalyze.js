import { Command } from 'commander';
import {
  listDailyFundFlowFiles,
  readDailyFundFlowPayload,
  applyStockFilters,
  checkSmallNetBuyStreak,
  changePctStddev,
  risingDaysGreater,
  storeDailyAnalysisFile,
  normalizeDateInput
} from '../services/storeDailyFlow.js';

export const reanalyzeCommand = new Command('reanalyze')
  .argument('<date>', 'download date (YYYY-MM-DD or YYYYMMDD)')
  .action((dateInput) => {
    const date = normalizeDateInput(dateInput);
    if (!date) {
      process.stderr.write('Invalid date format. Use YYYY-MM-DD or YYYYMMDD.\n');
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
        const check = applyStockFilters(code, [
          checkSmallNetBuyStreak(5),
          changePctStddev(1.62, 2.5),
          risingDaysGreater(),
        ], { rows, date });

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
          analysis_date: date
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
