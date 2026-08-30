import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initCommand } from '../src/commands/init.ts';
import { CLAUDE_CODE_STUB, CLAUDE_CODE_TEMPLATE } from '../src/config/template.ts';

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'jean-claude-init-'));
}

async function read(...segments: string[]): Promise<string> {
  return readFile(path.join(...segments), 'utf8');
}

describe('init', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scaffolds the config, the stub and the CA in one go', async () => {
    const home = await tempHome();
    expect(await initCommand({ home, claudeCode: false })).toBe(0);

    expect(await read(home, 'jean-claude.yaml')).toContain('api.example.com');
    expect(await read(home, 'responses', 'todos.json')).toContain('Dining');
    expect(await read(home, 'ca', 'ca.pem')).toContain('BEGIN CERTIFICATE');
    expect(await read(home, 'ca', 'bundle.pem')).toContain('# jean-claude CA');
  });

  it('writes the Claude Code freeze with --claude-code', async () => {
    const home = await tempHome();
    await initCommand({ home, claudeCode: true });

    expect(await read(home, 'jean-claude.yaml')).toBe(CLAUDE_CODE_TEMPLATE);
    expect(await read(home, 'responses', 'settings.GET.json')).toBe(CLAUDE_CODE_STUB);
  });

  it('never overwrites an edited config', async () => {
    const home = await tempHome();
    await initCommand({ home, claudeCode: false });
    await writeFile(path.join(home, 'jean-claude.yaml'), '# mine\nrules: []\n');

    await initCommand({ home, claudeCode: true });
    expect(await read(home, 'jean-claude.yaml')).toBe('# mine\nrules: []\n');
  });

  it('reuses the CA on a second run, so a trusted certificate survives', async () => {
    const home = await tempHome();
    await initCommand({ home, claudeCode: false });
    const first = await read(home, 'ca', 'ca.pem');

    await initCommand({ home, claudeCode: false });
    expect(await read(home, 'ca', 'ca.pem')).toBe(first);
  });
});
