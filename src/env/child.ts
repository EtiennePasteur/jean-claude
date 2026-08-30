/**
 * Builds the environment injected into the target tool.
 *
 * Two problems to solve: route the traffic through jean-claude (the `*_PROXY`
 * variables) and get its certificate accepted (the CA variables). Every HTTP
 * client has its own convention, hence the list.
 */

export interface ChildEnvOptions {
  proxyUrl: string;
  /** Path to the trust bundle (jean-claude CA + system store). */
  bundlePath: string;
  /**
   * Hosts to keep away from the proxy. Empty by default, on purpose.
   *
   * The tempting default is `localhost,127.0.0.1,::1`, but that silently makes
   * every localhost target bypass jean-claude - and intercepting a local dev API
   * is a common reason to reach for this tool in the first place. A bypass that
   * produces plausible-looking traffic is the worst possible failure mode, so
   * exclusions are opt-in through `noProxy:` in the config.
   */
  noProxy?: string[];
}

/** Variables added to, or overwritten in, the child environment. */
export function proxyEnvVars({ proxyUrl, bundlePath, noProxy }: ChildEnvOptions): Record<string, string> {
  const exclusions = noProxy?.filter((entry) => entry.trim() !== '') ?? [];

  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ...(exclusions.length > 0 ? { NO_PROXY: exclusions.join(','), no_proxy: exclusions.join(',') } : {}),

    // Node ignores the *_PROXY variables without this explicit opt-in.
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: bundlePath,

    // OpenSSL, curl, python/requests, the AWS CLI and git each want their own.
    SSL_CERT_FILE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    REQUESTS_CA_BUNDLE: bundlePath,
    AWS_CA_BUNDLE: bundlePath,
    GIT_SSL_CAINFO: bundlePath,
  };
}

/**
 * Variables that have to be *removed* rather than set. An inherited `NO_PROXY`
 * would otherwise punch a hole straight through the interception.
 */
export function proxyEnvUnset({ noProxy }: ChildEnvOptions): string[] {
  const exclusions = noProxy?.filter((entry) => entry.trim() !== '') ?? [];
  return exclusions.length > 0 ? [] : ['NO_PROXY', 'no_proxy'];
}

export function buildChildEnv(base: NodeJS.ProcessEnv, options: ChildEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...proxyEnvVars(options) };
  for (const name of proxyEnvUnset(options)) delete env[name];
  return env;
}

function parseVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

/**
 * `NODE_USE_ENV_PROXY` only exists from Node 22.21 / 24.5 onwards. Below that, a
 * Node-based target will ignore the proxy and its traffic will bypass jean-claude.
 */
export function nodeSupportsEnvProxy(version: string = process.versions.node): boolean {
  const [major, minor] = parseVersion(version);
  if (major >= 25) return true;
  if (major === 24) return minor >= 5;
  if (major === 23) return false; // odd release line, never backported
  if (major === 22) return minor >= 21;
  return false;
}

/** A shell-evaluable block, for `jean-claude start --export`. */
export function formatShellExports(vars: Record<string, string>, unset: string[] = []): string {
  const lines = Object.entries(vars).map(([key, value]) => `export ${key}='${value.replaceAll("'", `'\\''`)}'`);
  if (unset.length > 0) lines.push(`unset ${unset.join(' ')}`);
  return lines.join('\n');
}
