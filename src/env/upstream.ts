import type { Config } from '../config/schema.ts';

/**
 * jean-claude may itself be sitting behind a corporate proxy. This module reads
 * the environment *before* we rewrite it for the child process, and works out
 * where relayed traffic should be sent.
 */
export interface UpstreamSettings {
  proxyUrl: string;
  noProxy: string[] | undefined;
  /** Where the setting came from: inherited from the environment, or written in the config. */
  source: 'env' | 'config';
}

function firstDefined(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function parseNoProxy(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = firstDefined(env, ['NO_PROXY', 'no_proxy']);
  if (raw === undefined) return undefined;

  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.length > 0 ? entries : undefined;
}

/** The corporate CA that jean-claude itself must trust on outbound connections. */
export function inheritedExtraCaCerts(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.NODE_EXTRA_CA_CERTS;
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Resolve the upstream proxy. `upstream: off` forces a direct connection, `auto`
 * inherits from the environment, and an explicit URL wins over the environment.
 */
export function detectUpstream(config: Config, env: NodeJS.ProcessEnv = process.env): UpstreamSettings | undefined {
  if (config.upstream === 'off') return undefined;

  if (config.upstream !== 'auto') {
    return { proxyUrl: config.upstream, noProxy: parseNoProxy(env), source: 'config' };
  }

  const proxyUrl = firstDefined(env, ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
  if (proxyUrl === undefined) return undefined;

  return { proxyUrl, noProxy: parseNoProxy(env), source: 'env' };
}
