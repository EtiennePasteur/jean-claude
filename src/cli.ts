#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import pc from 'picocolors';

import { caCommand } from './commands/ca.ts';
import { checkCommand } from './commands/check.ts';
import { envCommand } from './commands/env.ts';
import { initCommand } from './commands/init.ts';
import { runCommand } from './commands/run.ts';
import { startCommand } from './commands/start.ts';
import type { SessionOptions } from './commands/shared.ts';

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError('expected a port between 1 and 65535.');
  }
  return port;
}

/** Shown wherever `--home` is offered, so the default is never a mystery. */
const HOME_DESCRIPTION = 'jean-claude directory: config, stubs, CA, session (default: ~/.config/jean-claude)';

interface RawSessionFlags {
  config?: string;
  port?: number;
  record?: string;
  home?: string;
  log?: string;
  verbose?: boolean;
  quiet?: boolean;
  watch?: boolean;
}

function toSessionOptions(flags: RawSessionFlags): SessionOptions {
  return {
    config: flags.config,
    port: flags.port,
    record: flags.record,
    home: flags.home,
    log: flags.log,
    verbose: flags.verbose ?? false,
    quiet: flags.quiet ?? false,
    watch: flags.watch ?? true,
  };
}

/** Flags common to `run` and `start`. */
function withSessionFlags(command: Command): Command {
  return command
    .option('-c, --config <path>', 'path to the config file (default: nearest jean-claude.yaml, then the home one)')
    .option('-p, --port <port>', 'port to listen on (default: a free port)', parsePort)
    .option('-r, --record <dir>', 'write real responses to this directory, ready to reuse as stubs')
    .option('--home <dir>', HOME_DESCRIPTION)
    .option('--log <path|terminal>', "where to write jean-claude's own log (default: a file while `run` has a child)")
    .option('-v, --verbose', 'also log traffic that matches no rule')
    .option('-q, --quiet', 'suppress the per-request log')
    .option('--no-watch', 'do not reload the config when it changes');
}

const program = new Command();

program
  .name('jean-claude')
  .description("MITM HTTPS proxy that rewrites another tool's API traffic, driven by a YAML file.")
  .version('0.3.0');

withSessionFlags(
  program
    .command('run', { isDefault: true })
    .description('run a command with its HTTPS traffic intercepted')
    .argument('<command...>', 'the command to run, after `--`'),
).action(async (command: string[], flags: RawSessionFlags) => {
  process.exitCode = await runCommand(command, toSessionOptions(flags));
});

withSessionFlags(program.command('start').description('run the proxy alone and print the variables to export'))
  .option('--json', 'print the settings as JSON')
  .option('--export', 'print only the shell export block')
  .action(async (flags: RawSessionFlags & { json?: boolean; export?: boolean }) => {
    process.exitCode = await startCommand({
      ...toSessionOptions(flags),
      json: flags.json ?? false,
      export: flags.export ?? false,
    });
  });

program
  .command('env')
  .description('print the environment for an already running `start`, for `eval "$(jean-claude env)"`')
  .option('--home <dir>', HOME_DESCRIPTION)
  .option('-p, --port <port>', 'target this port instead of discovering the running session', parsePort)
  .option('--json', 'print the variables as JSON')
  .action(async (flags: { home?: string; port?: number; json?: boolean }) => {
    process.exitCode = await envCommand({
      home: flags.home,
      port: flags.port,
      json: flags.json ?? false,
    });
  });

program
  .command('ca')
  .description('show the certificate store, and how to trust it')
  .option('--home <dir>', HOME_DESCRIPTION)
  .option('--print', 'write the CA certificate to stdout')
  .option('--install', 'show the commands to add the CA to the system trust store')
  .action(async (flags: { home?: string; print?: boolean; install?: boolean }) => {
    process.exitCode = await caCommand({
      home: flags.home,
      print: flags.print ?? false,
      install: flags.install ?? false,
    });
  });

program
  .command('check')
  .description('validate the config and print the rules as resolved')
  .option('-c, --config <path>', 'path to the config file')
  .option('--home <dir>', HOME_DESCRIPTION)
  .action(async (flags: { config?: string; home?: string }) => {
    process.exitCode = await checkCommand(flags.config, flags.home);
  });

program
  .command('init')
  .description('set up the jean-claude directory: config, sample stub and CA')
  .option('--home <dir>', HOME_DESCRIPTION)
  .option('--claude-code', "start from the rule that freezes Claude Code's managed settings")
  .action(async (flags: { home?: string; claudeCode?: boolean }) => {
    process.exitCode = await initCommand({ home: flags.home, claudeCode: flags.claudeCode ?? false });
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(`\n  ${pc.red('error')}  ${(error as Error).message}\n`);
  process.exitCode = 1;
}
