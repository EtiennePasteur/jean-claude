import path from 'node:path';

import pc from 'picocolors';

import { ensureCa, type EnsureCaResult } from '../ca/store.ts';
import { type LoadedConfig, loadConfig, resolveFromConfig } from '../config/load.ts';
import { caDirIn, jeanClaudeHome, logFileIn } from '../config/paths.ts';
import { watchConfig } from '../config/watch.ts';
import { nodeSupportsEnvProxy, proxyEnvUnset, proxyEnvVars } from '../env/child.ts';
import { detectUpstream, inheritedExtraCaCerts, type UpstreamSettings } from '../env/upstream.ts';
import { Reporter } from '../log/reporter.ts';
import { Recorder } from '../record/writer.ts';
import { type RunningProxy, startProxy } from '../proxy/server.ts';

/** Options shared by `run` and `start`. */
export interface SessionOptions {
  config: string | undefined;
  port: number | undefined;
  record: string | undefined;
  /** jean-claude directory holding the config, the stubs, the CA and the session file. */
  home: string | undefined;
  /** `--log`: a file path, or `terminal` to keep the log on screen. */
  log: string | undefined;
  verbose: boolean;
  quiet: boolean;
  watch: boolean;
}

export interface Session {
  loaded: LoadedConfig;
  /** Resolved jean-claude home, where `start` records the session. */
  home: string;
  ca: EnsureCaResult;
  upstream: UpstreamSettings | undefined;
  reporter: Reporter;
  proxy: RunningProxy;
  /** Environment variables to inject into the target tool. */
  env: Record<string, string>;
  /** Variables that must be removed from the target's environment. */
  unset: string[];
  stop: () => Promise<void>;
}

/** The value of `--log` / `logFile:` that means "leave the log on screen". */
export const LOG_TO_TERMINAL = 'terminal';

/**
 * Where jean-claude's own output should go, `undefined` meaning the terminal.
 *
 * `--log` wins over the config, which wins over the default. The default is a
 * file only when a child is about to take the terminal over *and* that terminal
 * is interactive: piping `run` into something else, or running it in CI, keeps
 * the log on the stream where it is expected.
 *
 * `logFile:` is read only when a child is spawned. `start` exists precisely to
 * give the log a terminal of its own, so a global `logFile:` silently muting it
 * would be a trap - there, only an explicit `--log` redirects.
 */
export function resolveLogDestination(
  session: Pick<Session, 'loaded' | 'home'>,
  options: { log: string | undefined; spawnsChild: boolean },
  cwd = process.cwd(),
): string | undefined {
  if (options.log === LOG_TO_TERMINAL) return undefined;
  // A path typed on the command line is relative to where it was typed; one
  // written in the config follows the same rule as every other config path.
  if (options.log !== undefined) return path.resolve(cwd, options.log);

  if (options.spawnsChild) {
    const fromConfig = session.loaded.config.logFile;
    if (fromConfig === LOG_TO_TERMINAL) return undefined;
    if (fromConfig !== undefined) return resolveFromConfig(session.loaded, fromConfig);
    if (process.stdout.isTTY === true) return logFileIn(session.home);
  }

  return undefined;
}

/**
 * Brings up everything `run` and `start` need: config, CA, upstream detection,
 * the proxy itself, and optional config hot-reload.
 */
export async function openSession(options: SessionOptions): Promise<Session> {
  const home = options.home !== undefined ? path.resolve(options.home) : jeanClaudeHome();
  const loaded = await loadConfig(options.config, { home });
  const reporter = new Reporter({ verbose: options.verbose, quiet: options.quiet });

  // Read before we overwrite anything: this is the corporate proxy and CA that
  // jean-claude itself has to go through.
  const inheritedCa = inheritedExtraCaCerts();
  const upstream = detectUpstream(loaded.config);

  const ca = await ensureCa({ dir: caDirIn(home), inheritedCa });
  const recorder = options.record !== undefined ? new Recorder(path.resolve(options.record)) : undefined;

  const proxy = await startProxy({
    loaded,
    ca,
    upstream,
    outboundTrust: ca.outboundTrust,
    reporter,
    recorder,
    port: options.port,
  });

  const childEnvOptions = {
    proxyUrl: proxy.url,
    bundlePath: ca.bundlePath,
    noProxy: loaded.config.noProxy,
  };
  const env = proxyEnvVars(childEnvOptions);
  const unset = proxyEnvUnset(childEnvOptions);

  let unwatch: (() => Promise<void>) | undefined;
  if (options.watch && loaded.filePath !== undefined) {
    const configPath = loaded.filePath;
    unwatch = watchConfig(configPath, async () => {
      try {
        const next = await loadConfig(configPath);
        await proxy.reload(next);
        reporter.info(pc.dim(`config reloaded - ${next.rules.length} rule(s)`));
      } catch (error) {
        reporter.warn(`config reload failed, keeping the previous rules:\n${(error as Error).message}`);
      }
    });
  }

  return {
    loaded,
    home,
    ca,
    upstream,
    reporter,
    proxy,
    env,
    unset,
    stop: async () => {
      await unwatch?.();
      await proxy.stop();
    },
  };
}

export function printBanner(session: Session, extra: [string, string][] = []): void {
  const { loaded, ca, upstream, proxy, reporter } = session;

  reporter.banner([
    ['proxy', proxy.url],
    ['ca', ca.certPath + (ca.created ? pc.dim('  (just generated)') : '')],
    ['bundle', ca.bundlePath],
    ['config', `${loaded.filePath ?? '(none)'}  ${pc.dim(`${loaded.rules.length} rule(s)`)}`],
    [
      'upstream',
      upstream !== undefined ? `${upstream.proxyUrl}  ${pc.dim(`(from ${upstream.source})`)}` : pc.dim('direct'),
    ],
    // Worth showing: an exclusion is the one thing that makes traffic invisible.
    ...(loaded.config.noProxy?.length ? ([['bypassed', loaded.config.noProxy.join(', ')]] as [string, string][]) : []),
    ...extra,
  ]);

  if (ca.inheritedCa !== undefined) {
    reporter.info(pc.dim(`Corporate CA folded into the bundle: ${ca.inheritedCa}`));
  }
  if (!nodeSupportsEnvProxy()) {
    reporter.warn(
      `Node ${process.versions.node} predates NODE_USE_ENV_PROXY (needs >=22.21 or >=24.5). ` +
        'Node-based targets will ignore the proxy - upgrade Node, or pass NODE_OPTIONS=--use-env-proxy yourself.',
    );
  }
}
