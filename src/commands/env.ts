import path from 'node:path';

import { caPathsIn } from '../ca/store.ts';
import { caDirIn, jeanClaudeHome } from '../config/paths.ts';
import { formatShellExports, proxyEnvUnset, proxyEnvVars } from '../env/child.ts';
import { readSessionFile } from '../env/session.ts';

export interface EnvOptions {
  home: string | undefined;
  /** Skip session discovery and target this port directly. */
  port: number | undefined;
  json: boolean;
}

/**
 * Prints the environment for a proxy that is *already running*, without starting
 * one. This is what makes the two-terminal workflow work:
 *
 *   terminal 1:  jean-claude start
 *   terminal 2:  eval "$(jean-claude env)" && claude
 *
 * `jean-claude start --export` cannot be used for this - it runs in the
 * foreground, so the command substitution would never return.
 */
export async function envCommand(options: EnvOptions): Promise<number> {
  const home = options.home !== undefined ? path.resolve(options.home) : jeanClaudeHome();

  // An explicit --port skips discovery, for a session started elsewhere.
  const { proxyUrl, bundlePath, noProxy } =
    options.port !== undefined
      ? {
          proxyUrl: `http://127.0.0.1:${options.port}`,
          bundlePath: caPathsIn(caDirIn(home)).bundlePath,
          noProxy: undefined,
        }
      : await (async () => {
          const session = await readSessionFile(home);
          return {
            proxyUrl: session.proxy,
            bundlePath: session.bundle,
            noProxy: session.noProxy ?? undefined,
          };
        })();

  const childEnvOptions = { proxyUrl, bundlePath, noProxy };
  const vars = proxyEnvVars(childEnvOptions);
  const unset = proxyEnvUnset(childEnvOptions);

  console.log(options.json ? JSON.stringify({ env: vars, unset }, null, 2) : formatShellExports(vars, unset));
  return 0;
}
