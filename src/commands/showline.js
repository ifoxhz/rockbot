import { Command } from 'commander';
import { startShowlineServer } from './showline-html-server.js';

export const showlineCommand = new Command('showline')
  .option('-p, --port <port>', 'http port', '7070')
  .action((options) => {
    const port = Number(options.port);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error('Invalid --port value');
    }
    startShowlineServer({ port });
  });
