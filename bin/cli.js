#!/usr/bin/env node
import '../src/bootstrap-env.js';
import { Command } from 'commander';
import { rockCommand } from '../src/commands/rock.js';
import { showCommand } from '../src/commands/show.js';
import { reanalyzeCommand } from '../src/commands/reanalyze.js';
import { showlineCommand } from '../src/commands/showline.js';
import { hotCommand } from '../src/commands/hot.js';

const program = new Command();

program
  .name('rockbot')
  .description('Stock analysis CLI')
  .version('0.1.0');

program.addCommand(rockCommand);
program.addCommand(showCommand);
program.addCommand(showlineCommand);
program.addCommand(reanalyzeCommand);
program.addCommand(hotCommand);

program.parse(process.argv);
