import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isProcessAlive,
  NoSessionError,
  readSessionFile,
  removeSessionFile,
  type SessionFile,
  sessionFilePath,
  writeSessionFile,
} from '../src/env/session.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'jean-claude-session-'));
}

function sessionFor(pid: number): SessionFile {
  return {
    proxy: 'http://127.0.0.1:8888',
    port: 8888,
    bundle: '/home/me/.config/jean-claude/ca/bundle.pem',
    config: '/work/jean-claude.yaml',
    noProxy: null,
    pid,
  };
}

describe('isProcessAlive', () => {
  it('recognises the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a pid that cannot exist as dead', () => {
    // Above every plausible pid_max, so it is guaranteed unused.
    expect(isProcessAlive(0x7fffffff)).toBe(false);
  });
});

describe('session file', () => {
  it('round-trips a live session', async () => {
    const dir = await tempDir();
    await writeSessionFile(dir, sessionFor(process.pid));

    const session = await readSessionFile(dir);
    expect(session.port).toBe(8888);
    expect(session.proxy).toBe('http://127.0.0.1:8888');
  });

  it('is written with owner-only permissions', async () => {
    const dir = await tempDir();
    await writeSessionFile(dir, sessionFor(process.pid));

    const { mode } = await import('node:fs/promises').then((fs) => fs.stat(sessionFilePath(dir)));
    expect(mode & 0o777).toBe(0o600);
  });

  it('points at `start` when no session exists', async () => {
    const dir = await tempDir();
    await expect(readSessionFile(dir)).rejects.toThrow(NoSessionError);
    await expect(readSessionFile(dir)).rejects.toThrow(/jean-claude start/);
  });

  it('refuses a stale session rather than handing out a dead port', async () => {
    const dir = await tempDir();
    await writeSessionFile(dir, sessionFor(0x7fffffff));

    await expect(readSessionFile(dir)).rejects.toThrow(/is not running/);
  });

  it('rejects an unreadable file', async () => {
    const dir = await tempDir();
    await writeFile(sessionFilePath(dir), 'not json');

    await expect(readSessionFile(dir)).rejects.toThrow(/unreadable/);
  });

  it('removes the file, and tolerates it being gone already', async () => {
    const dir = await tempDir();
    await writeSessionFile(dir, sessionFor(process.pid));
    await removeSessionFile(dir);
    await removeSessionFile(dir);

    await expect(readFile(sessionFilePath(dir), 'utf8')).rejects.toThrow();
  });
});
