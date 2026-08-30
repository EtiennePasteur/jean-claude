import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Headers, RequestRuleBuilder } from 'mockttp';

import type { CompiledRule } from '../config/load.ts';
import type { Reporter } from '../log/reporter.ts';
import type { Recorder } from '../record/writer.ts';
import { applyJsonPatch, deepMerge } from '../util/json.ts';
import { factsFromUrl, interpolate } from './match.ts';

/**
 * mockttp does not re-export its callback types from the package root, so we
 * derive them from the public builder type. That stays valid across versions.
 */
type PassThroughOptions = NonNullable<Parameters<RequestRuleBuilder['thenPassThrough']>[0]>;
export type BeforeRequest = NonNullable<PassThroughOptions['beforeRequest']>;
export type BeforeResponse = NonNullable<PassThroughOptions['beforeResponse']>;
export type ResponseCallback = Parameters<RequestRuleBuilder['thenCallback']>[0];

export interface ActionContext {
  /** Base directory for resolving file paths declared in the config. */
  baseDir: string;
  reporter: Reporter;
  recorder: Recorder | undefined;
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.csv': 'text/csv',
};

/** Headers to drop as soon as we send back a decoded body of a different size. */
const BODY_DEPENDENT_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding'];

function withoutBodyHeaders(headers: Headers): Headers {
  const result: Headers = { ...headers };
  for (const name of BODY_DEPENDENT_HEADERS) delete result[name];
  return result;
}

function lowercaseKeys(headers: Record<string, string> | undefined): Headers {
  if (headers === undefined) return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

interface StubContents {
  body: Buffer;
  contentType: string | undefined;
}

async function readStub(filePath: string): Promise<StubContents> {
  const body = await readFile(filePath);
  return { body, contentType: CONTENT_TYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()] };
}

/** Split an inline body: a string is sent as-is, anything else as JSON. */
function inlineBody(value: unknown): { body?: string; json?: unknown; contentType: string | undefined } {
  if (typeof value === 'string') return { body: value, contentType: 'text/plain; charset=utf-8' };
  return { json: value, contentType: undefined };
}

async function safeJson(body: { getJson(): Promise<object | undefined> }): Promise<unknown> {
  try {
    return await body.getJson();
  } catch {
    return undefined;
  }
}

/**
 * A `respond` rule: reply directly, the server is never contacted. The stub file
 * is re-read on every request, so editing it takes effect without a restart.
 */
export function makeRespondHandler(compiled: CompiledRule, ctx: ActionContext): ResponseCallback {
  const respond = compiled.rule.respond!;

  return async (request) => {
    const { params } = compiled.match(factsFromUrl(request.url, request.method));
    const relative = respond.file !== undefined ? interpolate(respond.file, params) : undefined;
    const filePath = relative !== undefined ? path.resolve(ctx.baseDir, relative) : undefined;

    ctx.reporter.action(request.id, 'stub', compiled.label, relative ?? 'inline');
    if (respond.delay !== undefined) await sleep(respond.delay);

    const headers = lowercaseKeys(respond.headers);
    const status = respond.status ?? 200;

    if (filePath !== undefined) {
      let stub: StubContents;
      try {
        stub = await readStub(filePath);
      } catch (cause) {
        ctx.reporter.warn(`${compiled.label}: cannot read stub (${filePath}) - ${(cause as Error).message}`);
        return { statusCode: 502, json: { error: 'jean-claude: stub not found', file: filePath } };
      }
      if (stub.contentType !== undefined && headers['content-type'] === undefined) {
        headers['content-type'] = stub.contentType;
      }
      return { statusCode: status, headers, body: stub.body };
    }

    if (respond.body !== undefined) {
      const { body, json, contentType } = inlineBody(respond.body);
      if (contentType !== undefined && headers['content-type'] === undefined) headers['content-type'] = contentType;
      return json !== undefined ? { statusCode: status, headers, json } : { statusCode: status, headers, body };
    }

    // `respond` with no body: status and headers only.
    return { statusCode: status, headers };
  };
}

/**
 * Tags the request for the log and, when the rule asks for it, rewrites the
 * URL / method / headers / body before it goes out to the server.
 */
export function makeBeforeRequest(compiled: CompiledRule | undefined, ctx: ActionContext): BeforeRequest {
  const rewrite = compiled?.rule.request;
  const kind = rewrite !== undefined ? 'rewrite' : compiled?.rule.patch !== undefined ? 'patch' : 'passthrough';

  return async (request) => {
    ctx.reporter.action(request.id, kind, compiled?.label);
    if (rewrite === undefined) return undefined;

    const { params } = compiled!.match(factsFromUrl(request.url, request.method));
    const url = new URL(request.url);
    if (rewrite.host !== undefined) url.host = rewrite.host;
    if (rewrite.path !== undefined) url.pathname = interpolate(rewrite.path, params);
    if (rewrite.query !== undefined) {
      for (const [key, value] of Object.entries(rewrite.query)) url.searchParams.set(key, value);
    }

    let headers: Headers = { ...request.headers, ...lowercaseKeys(rewrite.headers) };
    for (const name of rewrite.removeHeaders ?? []) delete headers[name.toLowerCase()];
    // Without this the target server sees the old host header and routes elsewhere.
    if (rewrite.host !== undefined) headers.host = url.host;

    const method = rewrite.method?.toUpperCase();

    if (rewrite.body === undefined && rewrite.merge === undefined) {
      return { url: url.toString(), method, headers };
    }

    headers = withoutBodyHeaders(headers);
    if (rewrite.merge !== undefined) {
      const current = await safeJson(request.body);
      return { url: url.toString(), method, headers, json: deepMerge(current, rewrite.merge) };
    }

    const { body, json } = inlineBody(rewrite.body);
    return { url: url.toString(), method, headers, ...(json !== undefined ? { json } : { body }) };
  };
}

/**
 * Records the real response (before any change) and then applies `patch`.
 *
 * Returns `undefined` when there is neither recording nor patching to do: mockttp
 * then avoids buffering the body and the passthrough stays streamed.
 */
export function makeBeforeResponse(compiled: CompiledRule | undefined, ctx: ActionContext): BeforeResponse | undefined {
  const patch = compiled?.rule.patch;
  if (patch === undefined && ctx.recorder === undefined) return undefined;

  return async (response, request) => {
    const decoded = (await response.body.getDecodedBuffer()) ?? Buffer.alloc(0);

    if (ctx.recorder !== undefined) {
      try {
        const written = await ctx.recorder.record(
          request.url,
          request.method,
          decoded,
          headerValue(response.headers, 'content-type'),
        );
        ctx.reporter.recorded(request.id, written);
      } catch (cause) {
        ctx.reporter.warn(`could not record ${request.url} - ${(cause as Error).message}`);
      }
    }

    if (patch === undefined) return undefined;
    if (patch.delay !== undefined) await sleep(patch.delay);

    const statusCode = patch.status ?? response.statusCode;
    // We always return an explicit, decoded body, which makes the headers
    // describing the original encoding wrong - so they get dropped.
    const headers = withoutBodyHeaders(
      patch.replaceHeaders !== undefined
        ? lowercaseKeys(patch.replaceHeaders)
        : { ...response.headers, ...lowercaseKeys(patch.headers) },
    );

    if (patch.file !== undefined) {
      const filePath = path.resolve(ctx.baseDir, patch.file);
      try {
        const stub = await readStub(filePath);
        if (stub.contentType !== undefined) headers['content-type'] = stub.contentType;
        return { statusCode, headers, body: stub.body };
      } catch (cause) {
        ctx.reporter.warn(`${compiled!.label}: cannot read stub (${filePath}) - ${(cause as Error).message}`);
        return { statusCode: 502, headers, json: { error: 'jean-claude: stub not found', file: filePath } };
      }
    }

    if (patch.body !== undefined) {
      const { body, json, contentType } = inlineBody(patch.body);
      if (contentType !== undefined) headers['content-type'] = contentType;
      return json !== undefined ? { statusCode, headers, json } : { statusCode, headers, body };
    }

    if (patch.merge !== undefined || patch.jsonPatch !== undefined) {
      const current = await safeJson(response.body);
      if (current === undefined) {
        ctx.reporter.warn(`${compiled!.label}: response is not JSON, \`merge\`/\`jsonPatch\` skipped`);
        return { statusCode, headers, body: decoded };
      }
      const patched =
        patch.merge !== undefined ? deepMerge(current, patch.merge) : applyJsonPatch(current, patch.jsonPatch!);
      return { statusCode, headers, json: patched };
    }

    // Status / headers / delay only: re-emit the original body untouched.
    return { statusCode, headers, body: decoded };
  };
}
