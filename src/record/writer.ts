import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes real responses to disk, in a tree that mirrors the URL. Only the body
 * is written, so the resulting file can be dropped straight into a `respond:` rule.
 */

const EXTENSION_BY_TYPE: [RegExp, string][] = [
  [/json/, 'json'],
  [/html/, 'html'],
  [/xml/, 'xml'],
  [/javascript|ecmascript/, 'js'],
  [/css/, 'css'],
  [/plain/, 'txt'],
];

function isJson(body: Buffer): boolean {
  if (body.length === 0) return false;
  try {
    JSON.parse(body.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

function extensionFor(contentType: string | undefined, body: Buffer): string {
  if (contentType !== undefined) {
    const lower = contentType.toLowerCase();
    for (const [pattern, extension] of EXTENSION_BY_TYPE) {
      if (pattern.test(lower)) return extension;
    }
  }
  // No usable content-type: try JSON, which is the common case here.
  return isJson(body) ? 'json' : 'bin';
}

/** Strip anything that has no business being in a file name. */
function sanitizeSegment(segment: string): string {
  const cleaned = segment.replaceAll(/[^A-Za-z0-9._@-]/g, '_');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

/**
 * Build the capture path. The query string is reduced to a short digest, so two
 * requests differing only by their parameters do not overwrite each other.
 */
export function capturePathFor(dir: string, url: string, method: string, extension: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');

  const parents = segments.slice(0, -1).map(sanitizeSegment);
  const leaf = sanitizeSegment(segments.at(-1) ?? 'index');
  const querySuffix =
    parsed.search === '' ? '' : `-${createHash('sha1').update(parsed.search).digest('hex').slice(0, 8)}`;

  const fileName = `${leaf}${querySuffix}.${method.toUpperCase()}.${extension}`;
  return path.join(dir, sanitizeSegment(parsed.host), ...parents, fileName);
}

function reindentJson(body: Buffer): string | Buffer {
  try {
    return `${JSON.stringify(JSON.parse(body.toString('utf8')), null, 2)}\n`;
  } catch {
    return body;
  }
}

export class Recorder {
  constructor(private readonly dir: string) {}

  /** Write the response body and return the path relative to the cwd, for logging. */
  async record(url: string, method: string, body: Buffer, contentType: string | undefined): Promise<string> {
    const extension = extensionFor(contentType, body);
    const target = capturePathFor(this.dir, url, method, extension);

    await mkdir(path.dirname(target), { recursive: true });

    // JSON is re-indented: a capture is meant to be read and edited.
    // A lying content-type must not make the capture fail.
    await writeFile(target, extension === 'json' ? reindentJson(body) : body);

    return path.relative(process.cwd(), target);
  }
}
