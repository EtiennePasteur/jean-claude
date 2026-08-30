import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';

import { beforeAll, describe, expect, it } from 'vitest';

import { resolveLogDestination } from '../src/commands/shared.ts';
import { compile } from '../src/config/load.ts';
import { Reporter } from '../src/log/reporter.ts';
import { captureOutputTo, sessionHeader } from '../src/log/sink.ts';

/**
 * The point of the capture is that a spawned TUI keeps the terminal to itself.
 * Every case restores the streams in a `finally`: leaking a redirect would eat
 * vitest's own output and make the failure unreadable.
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'jean-claude-log-'));
});

describe('captureOutputTo', () => {
  it('takes both streams, under a session header', async () => {
    const logPath = path.join(workDir, 'capture.log');
    const capture = await captureOutputTo(logPath, sessionHeader('claude'));
    try {
      process.stdout.write('a request line\n');
      process.stderr.write('a warning\n');
    } finally {
      await capture.close();
    }

    const written = await readFile(logPath, 'utf8');
    expect(written).toContain('a request line');
    expect(written).toContain('a warning');
    expect(written).toContain('=== jean-claude ');
    expect(written).toContain('claude ===');
  });

  /**
   * `console.*` and `process.emitWarning` are checked in a real process on
   * purpose: vitest swaps `console` for its own reporter, so under the suite
   * they never reach `process.stdout.write` and the assertion would be
   * meaningless. This is also the only way to prove the terminal stays clean,
   * which is the whole point of the feature.
   */
  it('takes console output and Node warnings in a real process, leaving the terminal clean', async () => {
    const logPath = path.join(workDir, 'real-process.log');
    const sink = pathToFileURL(path.resolve('src/log/sink.ts')).href;

    const { stdout, stderr } = await execa(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { captureOutputTo } = await import(${JSON.stringify(sink)});
         const capture = await captureOutputTo(${JSON.stringify(logPath)}, 'header');
         console.log('a request line');
         // mockttp reports upstream failures on its own, straight to console.
         console.error('Failed to handle request: unable to get local issuer certificate');
         process.emitWarning('something experimental', 'ExperimentalWarning');
         await new Promise((resolve) => setTimeout(resolve, 20));
         await capture.close();
         console.log('back on the terminal');`,
      ],
      { reject: false },
    );

    const written = await readFile(logPath, 'utf8');
    expect(written).toContain('a request line');
    expect(written).toContain('Failed to handle request');
    expect(written).toContain('something experimental');

    expect(stdout).toContain('back on the terminal');
    expect(stdout).not.toContain('a request line');
    expect(stderr).not.toContain('Failed to handle request');
  });

  it('restores the original streams on close', async () => {
    const before = process.stdout.write;
    const capture = await captureOutputTo(path.join(workDir, 'restore.log'), 'header');
    expect(process.stdout.write).not.toBe(before);

    await capture.close();
    expect(process.stdout.write).toBe(before);
  });

  it('strips the colours the terminal asked for', async () => {
    const logPath = path.join(workDir, 'colour.log');
    const capture = await captureOutputTo(logPath, 'header');
    try {
      // Written raw rather than through picocolors, which turns colour off when
      // stdout is not a terminal - exactly the case under vitest.
      process.stdout.write('\u001B[31m200\u001B[39m \u001B[2mstub\u001B[22m\n');
    } finally {
      await capture.close();
    }

    const written = await readFile(logPath, 'utf8');
    expect(written).toContain('200 stub');
    expect(written).not.toContain('\u001B');
  });

  it('appends, so two concurrent runs cannot wipe each other', async () => {
    const logPath = path.join(workDir, 'append.log');

    for (const line of ['first session', 'second session']) {
      const capture = await captureOutputTo(logPath, sessionHeader(line));
      try {
        process.stdout.write(`${line}\n`);
      } finally {
        await capture.close();
      }
    }

    const written = await readFile(logPath, 'utf8');
    expect(written).toContain('first session');
    expect(written).toContain('second session');
  });
});

/** `isTTY` is a plain property, so it is swapped rather than spied on. */
function withTty<T>(isTTY: boolean, run: () => T): T {
  const original = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
  }
}

describe('resolveLogDestination', () => {
  const session = (raw: unknown = {}) => ({ loaded: compile(raw, '/cfg', '/cfg/jean-claude.yaml'), home: '/jc' });

  it('sends a spawned run to the home log file, so the child keeps the terminal', () => {
    const resolved = withTty(true, () => resolveLogDestination(session(), { log: undefined, spawnsChild: true }));
    expect(resolved).toBe(path.join('/jc', 'jean-claude.log'));
  });

  it('stays on the stream when the output is not a terminal, for pipes and CI', () => {
    const resolved = withTty(false, () => resolveLogDestination(session(), { log: undefined, spawnsChild: true }));
    expect(resolved).toBeUndefined();
  });

  it('never redirects `start` on its own: its terminal is the point', () => {
    const resolved = withTty(true, () =>
      resolveLogDestination(session({ logFile: 'jean-claude.log' }), { log: undefined, spawnsChild: false }),
    );
    expect(resolved).toBeUndefined();
  });

  it('resolves `logFile:` against the config file, like every other config path', () => {
    const resolved = withTty(false, () =>
      resolveLogDestination(session({ logFile: 'traffic.log' }), { log: undefined, spawnsChild: true }),
    );
    expect(resolved).toBe(path.join('/cfg', 'traffic.log'));
  });

  it('resolves `--log` against the cwd, where it was typed', () => {
    const resolved = resolveLogDestination(session(), { log: 'traffic.log', spawnsChild: true }, '/work');
    expect(resolved).toBe(path.join('/work', 'traffic.log'));
  });

  it('takes `terminal` as a request to keep the log on screen', () => {
    expect(
      withTty(true, () => resolveLogDestination(session(), { log: 'terminal', spawnsChild: true })),
    ).toBeUndefined();
    expect(
      withTty(true, () =>
        resolveLogDestination(session({ logFile: 'terminal' }), { log: undefined, spawnsChild: true }),
      ),
    ).toBeUndefined();
  });

  it('lets `--log` win over the config', () => {
    const resolved = resolveLogDestination(
      session({ logFile: 'from-config.log' }),
      { log: 'from-flag.log', spawnsChild: true },
      '/work',
    );
    expect(resolved).toBe(path.join('/work', 'from-flag.log'));
  });
});

describe('Reporter.summary', () => {
  it('says nothing when no traffic went through', () => {
    expect(new Reporter({ verbose: false, quiet: false }).summary()).toBeUndefined();
  });

  it('counts under --quiet, since the summary is all a redirected run says', () => {
    const reporter = new Reporter({ verbose: false, quiet: true });
    reporter.seen('1', 'GET', 'https://example.com/a');
    reporter.action('1', 'stub', 'rule #1');
    reporter.response('1', 200);

    expect(reporter.summary()).toBe('1 request, 1 rule hit');
  });

  it('reports upstream failures separately from plain traffic', () => {
    const reporter = new Reporter({ verbose: false, quiet: true });
    reporter.seen('1', 'GET', 'https://example.com/a');
    reporter.response('1', 200);
    reporter.seen('2', 'GET', 'https://example.com/b');
    reporter.response('2', 200);
    reporter.seen('3', 'GET', 'https://example.com/c');
    reporter.upstreamFailed('3', { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });

    expect(reporter.summary()).toBe('3 requests, 1 upstream error');
  });

  it("ignores mockttp's synthetic 502 after an upstream failure", () => {
    const reporter = new Reporter({ verbose: false, quiet: true });
    reporter.seen('1', 'GET', 'https://example.com/a');
    reporter.upstreamFailed('1', { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
    // mockttp answers the client itself once the handler has thrown.
    reporter.response('1', 502);

    expect(reporter.summary()).toBe('1 request, 1 upstream error');
  });

  it('does not count a passthrough as a rule hit', () => {
    const reporter = new Reporter({ verbose: false, quiet: true });
    reporter.seen('1', 'GET', 'https://example.com/a');
    reporter.action('1', 'passthrough');
    reporter.response('1', 200);

    expect(reporter.summary()).toBe('1 request');
  });
});
