import os from 'node:os';
import path from 'node:path';

/**
 * Where jean-claude keeps everything: the config, its stubs, the CA and the
 * session file of a running `start`.
 *
 * A single folder rather than a config directory plus a state directory: the
 * primary use case is a *global* install ("freeze this API response everywhere"),
 * and one path to remember beats XDG purity here. `--home` relocates the lot.
 *
 *   <home>/jean-claude.yaml
 *   <home>/jean-claude.log
 *   <home>/responses/
 *   <home>/ca/{ca.pem,ca.key,bundle.pem}
 *   <home>/session.json
 */

export function jeanClaudeHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'jean-claude');
}

export function caDirIn(home: string): string {
  return path.join(home, 'ca');
}

export function responsesDirIn(home: string): string {
  return path.join(home, 'responses');
}

/** Where `run` sends its own log when a spawned tool owns the terminal. */
export function logFileIn(home: string): string {
  return path.join(home, 'jean-claude.log');
}
