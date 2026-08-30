import pc from 'picocolors';

import { formatShellExports } from '../env/child.ts';
import { removeSessionFile, writeSessionFile } from '../env/session.ts';
import { captureOutputTo, sessionHeader } from '../log/sink.ts';
import { openSession, printBanner, resolveLogDestination, type SessionOptions } from './shared.ts';

export interface StartOptions extends SessionOptions {
  /** Print the environment as JSON instead of a human-readable banner. */
  json: boolean;
  /** Print only the shell `export` block, ready to paste into another terminal. */
  export: boolean;
}

/** Runs the proxy in the foreground until interrupted, for targets we cannot spawn. */
export async function startCommand(options: StartOptions): Promise<number> {
  const session = await openSession(options);
  // No default and no `logFile:` here: `start` exists to give the log a terminal
  // of its own, so only an explicit `--log` sends it to a file.
  const logFile = resolveLogDestination(session, { log: options.log, spawnsChild: false });

  // Recorded so another shell can `eval "$(jean-claude env)"` and just work.
  await writeSessionFile(session.home, {
    proxy: session.proxy.url,
    port: session.proxy.port,
    bundle: session.ca.bundlePath,
    config: session.loaded.filePath ?? null,
    noProxy: session.loaded.config.noProxy ?? null,
    pid: process.pid,
  });

  try {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            proxy: session.proxy.url,
            port: session.proxy.port,
            ca: session.ca.certPath,
            bundle: session.ca.bundlePath,
            config: session.loaded.filePath,
            rules: session.loaded.rules.length,
            upstream: session.upstream?.proxyUrl ?? null,
            env: session.env,
            unset: session.unset,
          },
          null,
          2,
        ),
      );
    } else if (options.export) {
      console.log(formatShellExports(session.env, session.unset));
    } else {
      printBanner(session, logFile !== undefined ? [['log', logFile]] : []);
      console.log(`  ${pc.dim('In the shell that runs your tool:')}\n`);
      console.log(`    ${pc.bold('eval "$(jean-claude env)"')}\n`);
      console.log(`  ${pc.dim('Ctrl-C to stop.')}\n`);
    }

    const capture = logFile !== undefined ? await captureOutputTo(logFile, sessionHeader('start')) : undefined;
    try {
      await waitForInterrupt();
    } finally {
      await capture?.close();
    }
  } finally {
    await removeSessionFile(session.home);
    await session.stop();
  }

  return 0;
}

function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
  });
}
