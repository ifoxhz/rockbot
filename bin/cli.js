#!/usr/bin/env node
import { Command } from 'commander';
import { rockCommand } from '../src/commands/rock.js';
import { showCommand } from '../src/commands/show.js';
import { reanalyzeCommand } from '../src/commands/reanalyze.js';

const program = new Command();

program
  .name('rockbot')
  .description('Stock analysis CLI')
  .version('0.1.0');

program.addCommand(rockCommand);
program.addCommand(showCommand);
program.addCommand(reanalyzeCommand);

program.parse(process.argv);
