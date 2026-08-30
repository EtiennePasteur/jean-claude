import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { compile, ConfigError, findConfigFile, loadConfig } from '../src/config/load.ts';
import { jeanClaudeHome } from '../src/config/paths.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'jean-claude-config-'));
}

/**
 * Every `loadConfig` call has to pin the home, or the global fallback would pick
 * up the config of whoever is running the suite.
 */
async function emptyHome(): Promise<string> {
  return tempDir();
}

describe('configSchema', () => {
  it('defaults upstream to auto and rules to an empty list', () => {
    const { config } = compile({}, '/tmp');
    expect(config.upstream).toBe('auto');
    expect(config.rules).toEqual([]);
  });

  it('expands the short `respond` form', () => {
    const { config } = compile({ rules: [{ path: '/a', respond: './x.json' }] }, '/tmp');
    expect(config.rules[0]!.respond).toEqual({ file: './x.json' });
  });

  it('normalises methods to upper case', () => {
    const { config } = compile({ rules: [{ path: '/a', method: 'post', respond: './x.json' }] }, '/tmp');
    expect(config.rules[0]!.method).toEqual(['POST']);
  });

  it('rejects an unknown key, naming it', () => {
    expect(() => compile({ rules: [{ path: '/a', respnd: './x.json' }] }, '/tmp')).toThrow(/respnd/);
  });

  it('rejects a rule with no action', () => {
    expect(() => compile({ rules: [{ path: '/a' }] }, '/tmp')).toThrow(/`respond`, `patch` or `request`/);
  });

  it('rejects `respond` combined with `patch`', () => {
    expect(() => compile({ rules: [{ path: '/a', respond: './x.json', patch: { status: 500 } }] }, '/tmp')).toThrow(
      /mutually exclusive/,
    );
  });

  it('rejects `respond` combined with `request`', () => {
    expect(() => compile({ rules: [{ path: '/a', respond: './x.json', request: { host: 'z.com' } }] }, '/tmp')).toThrow(
      /no-op/,
    );
  });

  it('rejects `path` combined with `pathRegex`', () => {
    expect(() => compile({ rules: [{ path: '/a', pathRegex: '^/a$', respond: './x.json' }] }, '/tmp')).toThrow(
      /mutually exclusive/,
    );
  });

  it('rejects an empty `patch`', () => {
    expect(() => compile({ rules: [{ path: '/a', patch: {} }] }, '/tmp')).toThrow(/cannot be empty/);
  });

  it('rejects `file` combined with `body` inside `respond`', () => {
    expect(() => compile({ rules: [{ path: '/a', respond: { file: './x.json', body: {} } }] }, '/tmp')).toThrow(
      /mutually exclusive/,
    );
  });

  it('rejects an out-of-range status', () => {
    expect(() => compile({ rules: [{ path: '/a', patch: { status: 99 } }] }, '/tmp')).toThrow();
  });

  it('rejects a JSON Pointer that does not start with a slash', () => {
    expect(() =>
      compile({ rules: [{ path: '/a', patch: { jsonPatch: [{ op: 'replace', path: 'nope', value: 1 }] } }] }, '/tmp'),
    ).toThrow(/JSON Pointer/);
  });

  it('rejects an invalid upstream URL', () => {
    expect(() => compile({ upstream: 'not-a-url' }, '/tmp')).toThrow();
  });

  it('accepts an explicit upstream URL', () => {
    const { config } = compile({ upstream: 'http://proxy.internal:3128' }, '/tmp');
    expect(config.upstream).toBe('http://proxy.internal:3128');
  });

  it('accepts a log destination, including the `terminal` keyword', () => {
    expect(compile({ logFile: 'jean-claude.log' }, '/tmp').config.logFile).toBe('jean-claude.log');
    expect(compile({ logFile: 'terminal' }, '/tmp').config.logFile).toBe('terminal');
    expect(compile({}, '/tmp').config.logFile).toBeUndefined();
  });

  it('gives each rule a label', () => {
    const { rules } = compile(
      {
        rules: [
          { name: 'my rule', path: '/a', respond: './x.json' },
          { path: '/b', respond: './y.json' },
        ],
      },
      '/tmp',
    );
    expect(rules[0]!.label).toBe('my rule');
    expect(rules[1]!.label).toBe('rule #2 (/b)');
  });
});

describe('loadConfig', () => {
  it('reads a YAML file and records its directory as the base', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'jean-claude.yaml'), 'rules:\n  - path: /a\n    respond: ./x.json\n');

    const loaded = await loadConfig(undefined, { cwd: dir, home: await emptyHome() });
    expect(loaded.baseDir).toBe(dir);
    expect(loaded.rules).toHaveLength(1);
  });

  it('treats an empty file as an empty config', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'jean-claude.yaml'), '');

    const loaded = await loadConfig(undefined, { cwd: dir, home: await emptyHome() });
    expect(loaded.config.rules).toEqual([]);
  });

  it('reports invalid YAML with the file name', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'jean-claude.yaml'), 'rules:\n  - path: [unclosed\n');

    await expect(loadConfig(undefined, { cwd: dir, home: await emptyHome() })).rejects.toThrow(/invalid YAML/);
  });

  it('suggests `init` when there is no config at all', async () => {
    const dir = await tempDir();
    await expect(loadConfig(undefined, { cwd: dir, home: await emptyHome() })).rejects.toThrow(/jean-claude init/);
  });

  it('fails on an explicit path that does not exist', async () => {
    const dir = await tempDir();
    await expect(loadConfig('nope.yaml', { cwd: dir, home: await emptyHome() })).rejects.toThrow(ConfigError);
  });
});

describe('findConfigFile', () => {
  it('walks up to a parent directory', async () => {
    const dir = await tempDir();
    const nested = path.join(dir, 'a', 'b');
    await writeFile(path.join(dir, 'jean-claude.yaml'), 'rules: []\n');

    expect(await findConfigFile(nested, await emptyHome())).toBe(path.join(dir, 'jean-claude.yaml'));
  });

  it('falls back to the jean-claude home when nothing is found on the way up', async () => {
    const home = await tempDir();
    await writeFile(path.join(home, 'jean-claude.yaml'), 'rules: []\n');

    expect(await findConfigFile(await tempDir(), home)).toBe(path.join(home, 'jean-claude.yaml'));
  });

  it('prefers a local config over the home one', async () => {
    const home = await tempDir();
    const dir = await tempDir();
    await writeFile(path.join(home, 'jean-claude.yaml'), 'rules: []\n');
    await writeFile(path.join(dir, 'jean-claude.yaml'), 'rules: []\n');

    expect(await findConfigFile(dir, home)).toBe(path.join(dir, 'jean-claude.yaml'));
  });

  it('finds nothing when neither the tree nor the home has a config', async () => {
    expect(await findConfigFile(await tempDir(), await tempDir())).toBeUndefined();
  });
});

describe('jeanClaudeHome', () => {
  it('honours XDG_CONFIG_HOME', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg');
    expect(jeanClaudeHome()).toBe(path.join('/xdg', 'jean-claude'));
    vi.unstubAllEnvs();
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or blank', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    expect(jeanClaudeHome()).toBe(path.join(os.homedir(), '.config', 'jean-claude'));
    vi.unstubAllEnvs();
  });
});
