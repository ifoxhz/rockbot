#!/usr/bin/env node
import { Command } from 'commander';
import { rockCommand } from '../src/commands/rock.js';

const program = new Command();

program
  .name('mycli')
  .description('Stock analysis CLI')
  .version('0.1.0');

program.addCommand(rockCommand);

program.parse(process.argv);
