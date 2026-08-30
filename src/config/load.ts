import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';

import { compileMatcher, describeRule, type MatchResult, type RequestFacts } from '../proxy/match.ts';
import { jeanClaudeHome } from './paths.ts';
import { type Config, configSchema, type Rule } from './schema.ts';

/** File names searched for when `--config` is not given. */
export const CONFIG_FILENAMES = ['jean-claude.yaml', 'jean-claude.yml'] as const;

/** The config `init` writes, and the fallback when no local one is found. */
export function configPathIn(home: string): string {
  return path.join(home, CONFIG_FILENAMES[0]);
}

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

export interface CompiledRule {
  rule: Rule;
  /** Human readable label, used in logs and error messages. */
  label: string;
  match: (facts: RequestFacts) => MatchResult;
}

export interface LoadedConfig {
  config: Config;
  rules: CompiledRule[];
  /** Absolute path of the config file, `undefined` for a synthetic config. */
  filePath: string | undefined;
  /** Directory that relative paths in the config are resolved against. */
  baseDir: string;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(`cannot read ${filePath}: ${(cause as Error).message}`, { cause });
  }
}

/**
 * Look for a config file in `cwd`, then walk up the parent directories, then
 * fall back to the one `init` writes in the jean-claude home.
 *
 * The global fallback is what lets a single rule apply everywhere - the main
 * reason to reach for this tool. A project-local file still wins, so a repo can
 * override the global rules for its own traffic.
 */
export async function findConfigFile(cwd: string, home = jeanClaudeHome()): Promise<string | undefined> {
  let dir = path.resolve(cwd);

  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if ((await readIfPresent(candidate)) !== undefined) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(home, name);
    if ((await readIfPresent(candidate)) !== undefined) return candidate;
  }
  return undefined;
}

/** Validate an already parsed object. Exposed for tests and for `check`. */
export function compile(raw: unknown, baseDir: string, filePath?: string): LoadedConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const where = filePath ? ` in ${filePath}` : '';
    throw new ConfigError(`invalid configuration${where}:\n${z.prettifyError(parsed.error)}`);
  }

  const config = parsed.data;
  const rules = config.rules.map((rule, index) => ({
    rule,
    label: describeRule(rule, index),
    match: compileMatcher(rule, config, index),
  }));

  return { config, rules, filePath, baseDir };
}

export interface LoadOptions {
  cwd?: string;
  /** jean-claude home searched last, when nothing is found by walking up. */
  home?: string;
}

export async function loadConfig(explicitPath?: string, options: LoadOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? jeanClaudeHome();
  const filePath = explicitPath ? path.resolve(cwd, explicitPath) : await findConfigFile(cwd, home);

  if (filePath === undefined) {
    throw new ConfigError(
      `no configuration file found (${CONFIG_FILENAMES.join(' or ')}).\n` +
        `  Searched from ${cwd} up to the root, then ${home}.\n` +
        '  Run `jean-claude init` to create one.',
    );
  }

  const source = await readIfPresent(filePath);
  if (source === undefined) throw new ConfigError(`configuration file not found: ${filePath}`);

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (cause) {
    const detail = cause instanceof YAMLParseError ? cause.message : (cause as Error).message;
    throw new ConfigError(`invalid YAML in ${filePath}:\n${detail}`, { cause });
  }

  if (raw === null || raw === undefined) raw = {};

  return compile(raw, path.dirname(filePath), filePath);
}

/** Resolve a path declared in the config, relative to the config file. */
export function resolveFromConfig(loaded: Pick<LoadedConfig, 'baseDir'>, target: string): string {
  return path.resolve(loaded.baseDir, target);
}
