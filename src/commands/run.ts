import { execa } from 'execa';
import pc from 'picocolors';

import { buildChildEnv } from '../env/child.ts';
import { captureOutputTo, sessionHeader } from '../log/sink.ts';
import { openSession, printBanner, resolveLogDestination, type SessionOptions } from './shared.ts';

/**
 * Starts the proxy, then runs the target command with the proxy and CA
 * variables already in its environment. Exits with the child's exit code.
 */
export async function runCommand(command: string[], options: SessionOptions): Promise<number> {
  const [file, ...args] = command;
  if (file === undefined) {
    throw new Error('nothing to run: pass the target command after `--`, e.g. `jean-claude run -- npx my-tool`.');
  }

  const session = await openSession(options);
  const logFile = resolveLogDestination(session, { log: options.log, spawnsChild: true });

  // Printed before the child exists, so it cannot land in the middle of a
  // redraw - and it is where the log path is announced.
  printBanner(session, [
    ...(logFile !== undefined ? ([['log', `${logFile}  ${pc.dim('(tail -f to follow)')}`]] as [string, string][]) : []),
    ['command', command.join(' ')],
  ]);

  // The terminal delivers Ctrl-C to the whole process group, so the child gets
  // it directly. We only swallow it here to keep the cleanup below running.
  const swallow = (): void => {};
  process.on('SIGINT', swallow);
  process.on('SIGTERM', swallow);

  // From here until the child is gone, the terminal belongs to it: a request
  // line landing in a full-screen TUI corrupts the display.
  const capture = logFile !== undefined ? await captureOutputTo(logFile, sessionHeader(command.join(' '))) : undefined;

  try {
    const result = await execa(file, args, {
      env: buildChildEnv(process.env, {
        proxyUrl: session.proxy.url,
        bundlePath: session.ca.bundlePath,
        noProxy: session.loaded.config.noProxy,
      }),
      stdio: 'inherit',
      reject: false,
    });
    return result.exitCode ?? 0;
  } finally {
    process.off('SIGINT', swallow);
    process.off('SIGTERM', swallow);
    await session.stop();
    // Release the terminal before anything else reports: `session.stop()` may
    // still log, and the CLI's top-level handler prints there too.
    await capture?.close();

    const summary = session.reporter.summary();
    if (summary !== undefined && !options.quiet) {
      const where = capture !== undefined ? `  ${pc.dim(`→ ${capture.path}`)}` : '';
      console.log(`\n  ${summary}${where}\n`);
    }
  }
}
