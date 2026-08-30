import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A running `start` session, recorded on disk so a *second* shell can pick up
 * the environment without starting a proxy of its own.
 *
 * This exists because the obvious `eval "$(jean-claude start --export)"` cannot
 * work: `start` runs in the foreground, so the command substitution would never
 * return. `start` writes this file, `env` reads it.
 */
export interface SessionFile {
  proxy: string;
  port: number;
  bundle: string;
  config: string | null;
  noProxy: string[] | null;
  /** Used to detect a file left behind by a session that is no longer running. */
  pid: number;
}

export function sessionFilePath(home: string): string {
  return path.join(home, 'session.json');
}

export async function writeSessionFile(home: string, session: SessionFile): Promise<void> {
  await writeFile(sessionFilePath(home), `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export async function removeSessionFile(home: string): Promise<void> {
  await rm(sessionFilePath(home), { force: true });
}

/** Signal 0 probes for existence without actually signalling the process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSessionError';
  }
}

/** Reads the session file, refusing anything stale so callers never get a dead port. */
export async function readSessionFile(home: string): Promise<SessionFile> {
  const filePath = sessionFilePath(home);

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NoSessionError(
        'no running session found.\n' +
          '  Start one in another terminal with `jean-claude start`, or pass `--port` explicitly.',
      );
    }
    throw cause;
  }

  let session: SessionFile;
  try {
    session = JSON.parse(raw) as SessionFile;
  } catch {
    throw new NoSessionError(`session file is unreadable: ${filePath}`);
  }

  if (!isProcessAlive(session.pid)) {
    throw new NoSessionError(
      `the session recorded in ${filePath} is gone (pid ${session.pid} is not running).\n` +
        '  Start a new one with `jean-claude start`.',
    );
  }

  return session;
}
