import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/**
 * Sends everything *this* process writes to a file, so a spawned tool can own
 * the terminal.
 *
 * The two stream `write` methods are patched rather than `console`, because
 * `console.*` calls them internally and so does the default handler for
 * `process.emitWarning`. That makes this the single choke point for our own
 * output - including the `console.error` calls mockttp makes on its own, which
 * no amount of discipline inside `Reporter` would have caught.
 *
 * The child process is unaffected: `stdio: 'inherit'` hands it the file
 * descriptors, not our JavaScript streams.
 */
export interface OutputCapture {
  /** The file being written to, for the banner. */
  path: string;
  /** Restore the streams, then flush and close the file. */
  close: () => Promise<void>;
}

function redirect(stream: NodeJS.WriteStream, sink: WriteStream): () => void {
  // The reference, not a bound copy: restoring a wrapper would leave a layer
  // behind on every capture and break `write === the original write`.
  const original = stream.write;

  stream.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    // Colour is emitted because our stdout *is* a terminal - which is exactly
    // when we redirect. Escape codes in a log file do not grep.
    sink.write(stripVTControlCharacters(text));

    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  }) as typeof stream.write;

  return () => {
    stream.write = original;
  };
}

/**
 * Start capturing. `header` opens the session in the file: the log is appended
 * to, never truncated, so two concurrent runs cannot wipe each other's output.
 */
export async function captureOutputTo(filePath: string, header: string): Promise<OutputCapture> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const sink = createWriteStream(filePath, { flags: 'a' });
  sink.write(`\n${header}\n`);

  const restore = [redirect(process.stdout, sink), redirect(process.stderr, sink)];

  return {
    path: filePath,
    close: async () => {
      for (const undo of restore) undo();
      await new Promise<void>((resolve) => sink.end(resolve));
    },
  };
}

/** Opening line of a captured session, so a shared log stays readable. */
export function sessionHeader(command: string, now = new Date()): string {
  return `=== jean-claude ${now.toISOString()} pid ${process.pid} - ${command} ===`;
}
