import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// `getCA` is not re-exported from the package root, but mockttp's exports map
// publishes `./dist/*`. Test-only code, used to mint the fake upstream's leaf.
import { generateCACertificate } from 'mockttp';
import { getCA } from 'mockttp/dist/util/certificates';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ensureCa, type EnsureCaResult } from '../src/ca/store.ts';
import { compile } from '../src/config/load.ts';
import { Reporter } from '../src/log/reporter.ts';
import { type RunningProxy, startProxy } from '../src/proxy/server.ts';
import { Recorder } from '../src/record/writer.ts';

/**
 * End-to-end coverage of the original use case: a tool calls a server, and
 * jean-claude changes what the tool receives without the tool noticing.
 *
 * The fake upstream is a plain `node:https` server holding a leaf certificate
 * minted by jean-claude's own CA, so no network access is involved. Using a real
 * server rather than a second mockttp instance is deliberate - mockttp talking
 * to mockttp stalls for ~15s on the first connection, which made the suite look
 * pathologically slow for reasons that had nothing to do with jean-claude.
 */

const ORIGINAL = [{ title: 'Shopping', details: 'bla-bla-bla' }];

let workDir: string;
let ca: EnsureCaResult;
let ourCaCert: string;
let upstream: https.Server;
let upstreamPort: number;
let upstreamHits: string[] = [];
let running: RunningProxy | undefined;

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function request(url: string, agent: https.Agent, method = 'GET', payload?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { agent, method }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Starts jean-claude in front of the fake upstream, from a raw config object. */
async function startWith(raw: unknown, options: { record?: string; reporter?: Reporter } = {}): Promise<https.Agent> {
  const loaded = compile(raw, workDir, path.join(workDir, 'jean-claude.yaml'));

  running = await startProxy({
    loaded,
    ca,
    upstream: undefined,
    // The fake upstream's leaf is signed by jean-claude's own CA, so trusting it
    // on the way out is what lets the relay work - and it exercises
    // `additionalTrustedCAs`.
    outboundTrust: ourCaCert,
    reporter: options.reporter ?? new Reporter({ verbose: false, quiet: true }),
    recorder: options.record !== undefined ? new Recorder(options.record) : undefined,
    port: undefined,
  });

  return new https.Agent({
    proxyEnv: { HTTPS_PROXY: running.url, NODE_USE_ENV_PROXY: '1' },
    ca: ourCaCert,
  });
}

function upstreamUrl(pathname: string): string {
  return `https://localhost:${upstreamPort}${pathname}`;
}

/** Host segment as the recorder sanitises it: `:` is not filename-safe. */
function captureHost(): string {
  return `localhost_${upstreamPort}`;
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'jean-claude-e2e-'));
  ca = await ensureCa({ dir: path.join(workDir, 'ca') });
  ourCaCert = await readFile(ca.certPath, 'utf8');

  await mkdir(path.join(workDir, 'responses'), { recursive: true });
  await writeFile(
    path.join(workDir, 'responses', 'todos.json'),
    `${JSON.stringify([{ title: 'Dining', details: 'bla-bla-bla' }], null, 2)}\n`,
  );

  const authority = await getCA({ certPath: ca.certPath, keyPath: ca.keyPath });
  const leaf = await authority.generateCertificate('localhost');

  upstream = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://localhost');
    upstreamHits.push(`${req.method} ${url.pathname} auth=${req.headers.authorization ?? '-'}`);
    req.resume(); // drain any request body, otherwise POSTs hang

    if (url.pathname === '/api/text') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json at all');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ORIGINAL));
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  upstreamHits = [];
});

describe('respond - replace the response with a file', () => {
  it('serves the stub and never contacts the server', async () => {
    const agent = await startWith({
      rules: [{ path: '/api/todos', method: 'GET', respond: './responses/todos.json' }],
    });

    const res = await request(upstreamUrl('/api/todos'), agent);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ title: 'Dining', details: 'bla-bla-bla' }]);
    expect(res.headers['content-type']).toContain('application/json');
    // The whole point of a short circuit: the server was never reached.
    expect(upstreamHits).toEqual([]);
  });

  it('honours status, headers and delay', async () => {
    const agent = await startWith({
      rules: [
        {
          path: '/api/todos',
          respond: { file: './responses/todos.json', status: 201, headers: { 'x-jean-claude': 'stub' }, delay: 60 },
        },
      ],
    });

    const startedAt = process.hrtime.bigint();
    const res = await request(upstreamUrl('/api/todos'), agent);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(res.status).toBe(201);
    expect(res.headers['x-jean-claude']).toBe('stub');
    expect(elapsedMs).toBeGreaterThanOrEqual(50);
  });

  it('serves an inline body', async () => {
    const agent = await startWith({ rules: [{ path: '/api/todos', respond: { body: { ok: true } } }] });

    const res = await request(upstreamUrl('/api/todos'), agent);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('interpolates a captured parameter into the stub path', async () => {
    await mkdir(path.join(workDir, 'responses', 'users'), { recursive: true });
    await writeFile(path.join(workDir, 'responses', 'users', '42.json'), '{"id":42}');

    const agent = await startWith({
      rules: [{ path: '/api/users/:id', respond: './responses/users/{id}.json' }],
    });

    const res = await request(upstreamUrl('/api/users/42'), agent);
    expect(JSON.parse(res.body)).toEqual({ id: 42 });
    expect(upstreamHits).toEqual([]);
  });

  it('reports a missing stub as a 502 rather than failing opaquely', async () => {
    const agent = await startWith({ rules: [{ path: '/api/todos', respond: './responses/absent.json' }] });

    const res = await request(upstreamUrl('/api/todos'), agent);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/stub not found/);
  });
});

describe('patch - modify the real response', () => {
  it('rewrites a field with jsonPatch, having reached the server', async () => {
    const agent = await startWith({
      rules: [{ path: '/api/todos', patch: { jsonPatch: [{ op: 'replace', path: '/0/title', value: 'Dining' }] } }],
    });

    const res = await request(upstreamUrl('/api/todos'), agent);

    expect(JSON.parse(res.body)).toEqual([{ title: 'Dining', details: 'bla-bla-bla' }]);
    expect(upstreamHits).toEqual(['GET /api/todos auth=-']);
  });

  it('adds a field to an element of an array response', async () => {
    const agent = await startWith({
      rules: [{ path: '/api/todos', patch: { jsonPatch: [{ op: 'add', path: '/0/done', value: true }] } }],
    });

    const res = await request(upstreamUrl('/api/todos'), agent);
    expect(JSON.parse(res.body)[0]).toEqual({ title: 'Shopping', details: 'bla-bla-bla', done: true });
  });

  it('forces a status while preserving the original body', async () => {
    const agent = await startWith({ rules: [{ path: '/api/todos', patch: { status: 503 } }] });

    const res = await request(upstreamUrl('/api/todos'), agent);

    expect(res.status).toBe(503);
    // Guards against a regression where a partial result would blank the body.
    expect(JSON.parse(res.body)).toEqual(ORIGINAL);
  });

  it('merges headers without dropping the server ones', async () => {
    const agent = await startWith({
      rules: [{ path: '/api/todos', patch: { headers: { 'x-added': 'yes' } } }],
    });

    const res = await request(upstreamUrl('/api/todos'), agent);
    expect(res.headers['x-added']).toBe('yes');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('replaces the body with an inline value', async () => {
    const agent = await startWith({ rules: [{ path: '/api/todos', patch: { status: 500, body: { error: 'boom' } } }] });

    const res = await request(upstreamUrl('/api/todos'), agent);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'boom' });
  });

  it('leaves a non-JSON response untouched instead of corrupting it', async () => {
    const agent = await startWith({
      rules: [{ path: '/api/text', patch: { jsonPatch: [{ op: 'replace', path: '/0/title', value: 'x' }] } }],
    });

    const res = await request(upstreamUrl('/api/text'), agent);
    expect(res.body).toBe('not json at all');
  });
});

describe('request - rewrite the outgoing request', () => {
  it('rewrites the path and injects a header', async () => {
    const agent = await startWith({
      rules: [{ path: '/api/todos', request: { path: '/api/v2/todos', headers: { authorization: 'Bearer TEST' } } }],
    });

    await request(upstreamUrl('/api/todos'), agent);

    expect(upstreamHits).toEqual(['GET /api/v2/todos auth=Bearer TEST']);
  });

  it('combines a request rewrite with a response patch', async () => {
    const agent = await startWith({
      rules: [
        {
          path: '/api/todos',
          request: { path: '/api/v2/todos' },
          patch: { jsonPatch: [{ op: 'replace', path: '/0/title', value: 'Dining' }] },
        },
      ],
    });

    const res = await request(upstreamUrl('/api/todos'), agent);

    expect(upstreamHits).toEqual(['GET /api/v2/todos auth=-']);
    expect(JSON.parse(res.body)[0].title).toBe('Dining');
  });

  it('removes a header', async () => {
    const agent = await startWith({
      rules: [
        { path: '/api/todos', request: { headers: { authorization: 'Bearer X' }, removeHeaders: ['authorization'] } },
      ],
    });

    await request(upstreamUrl('/api/todos'), agent);
    expect(upstreamHits).toEqual(['GET /api/todos auth=-']);
  });
});

describe('unmatched traffic', () => {
  it('is relayed untouched', async () => {
    const agent = await startWith({ rules: [{ path: '/api/other', respond: './responses/todos.json' }] });

    const res = await request(upstreamUrl('/api/todos'), agent);

    expect(JSON.parse(res.body)).toEqual(ORIGINAL);
    expect(upstreamHits).toEqual(['GET /api/todos auth=-']);
  });

  it('respects rule order, first match wins', async () => {
    const agent = await startWith({
      rules: [
        { name: 'first', path: '/api/todos', respond: { body: { winner: 'first' } } },
        { name: 'second', path: '/api/todos', respond: { body: { winner: 'second' } } },
      ],
    });

    const res = await request(upstreamUrl('/api/todos'), agent);
    expect(JSON.parse(res.body)).toEqual({ winner: 'first' });
  });

  it('does not apply a rule scoped to another host', async () => {
    const agent = await startWith({
      rules: [{ host: 'elsewhere.example.com', path: '/api/todos', respond: { body: { nope: true } } }],
    });

    const res = await request(upstreamUrl('/api/todos'), agent);
    expect(JSON.parse(res.body)).toEqual(ORIGINAL);
  });
});

describe('recording', () => {
  it('writes the real response, ready to reuse as a stub', async () => {
    const captureDir = path.join(workDir, 'captures');
    const agent = await startWith({ rules: [] }, { record: captureDir });

    await request(upstreamUrl('/api/todos'), agent);

    const written = path.join(captureDir, captureHost(), 'api', 'todos.GET.json');
    expect(JSON.parse(await readFile(written, 'utf8'))).toEqual(ORIGINAL);
  });

  it('captures the server response even when the rule patches it', async () => {
    const captureDir = path.join(workDir, 'captures-patched');
    const agent = await startWith(
      { rules: [{ path: '/api/todos', patch: { jsonPatch: [{ op: 'replace', path: '/0/title', value: 'Dining' }] } }] },
      { record: captureDir },
    );

    const res = await request(upstreamUrl('/api/todos'), agent);

    expect(JSON.parse(res.body)[0].title).toBe('Dining');
    const written = path.join(captureDir, captureHost(), 'api', 'todos.GET.json');
    // The capture is the untouched server response, not what the client saw.
    expect(JSON.parse(await readFile(written, 'utf8'))).toEqual(ORIGINAL);
  });
});

describe('hot reload', () => {
  it('applies a new rule set without restarting', async () => {
    const agent = await startWith({ rules: [] });

    expect(JSON.parse((await request(upstreamUrl('/api/todos'), agent)).body)).toEqual(ORIGINAL);

    await running!.reload(
      compile({ rules: [{ path: '/api/todos', respond: './responses/todos.json' }] }, workDir, 'x.yaml'),
    );

    const after = await request(upstreamUrl('/api/todos'), agent);
    expect(JSON.parse(after.body)[0].title).toBe('Dining');
  });

  it('keeps logging after a reload, proving listeners were re-attached', async () => {
    const agent = await startWith({ rules: [] });
    await running!.reload(compile({ rules: [] }, workDir, 'x.yaml'));

    // A response still arriving means the event subscriptions survived reset().
    const res = await request(upstreamUrl('/api/todos'), agent);
    expect(res.status).toBe(200);
  });
});

/**
 * A server jean-claude cannot verify. Nothing on the client side goes wrong -
 * the tool gets a perfectly valid 500 - so unless the relay leg reports itself,
 * the only trace is a bare `Failed to handle request:` from mockttp naming
 * neither the host nor the request.
 */
describe('an upstream jean-claude does not trust', () => {
  let stranger: https.Server;
  let strangerPort: number;

  beforeAll(async () => {
    const strangerCa = await generateCACertificate({ subject: { commonName: 'somebody else entirely' } });
    const authority = await getCA({ key: strangerCa.key, cert: strangerCa.cert });
    const leaf = await authority.generateCertificate('localhost');

    stranger = https.createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => res.end('never read'));
    await new Promise<void>((resolve) => stranger.listen(0, '127.0.0.1', resolve));
    strangerPort = (stranger.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stranger.close(() => resolve()));
  });

  it('reports the request and the OpenSSL reason', async () => {
    const lines: string[] = [];
    const capture = (line: unknown) => void lines.push(String(line));
    const log = vi.spyOn(console, 'log').mockImplementation(capture);
    const warn = vi.spyOn(console, 'warn').mockImplementation(capture);

    try {
      const agent = await startWith({ rules: [] }, { reporter: new Reporter({ verbose: true, quiet: false }) });
      const res = await request(`https://localhost:${strangerPort}/api/todos`, agent);
      // mockttp turns an unreachable upstream into a 502 for the client.
      expect(res.status).toBe(502);

      // mockttp defers rule events through setImmediate.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }

    const output = lines.join('\n');
    expect(output).toContain(`localhost:${strangerPort}/api/todos`);
    expect(output).toContain('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(output).toContain('NODE_EXTRA_CA_CERTS');
  });
});
