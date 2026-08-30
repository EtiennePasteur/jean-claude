import { z } from 'zod';

/**
 * Schema for the `jean-claude.yaml` file. This is the source of truth for the
 * config format: the README and the `check` command both derive from it.
 */

const headersSchema = z.record(z.string(), z.string());

const statusSchema = z.number().int().min(100).max(599);

const delaySchema = z.number().int().nonnegative().max(600_000);

/** A single method, or a list of methods, normalised to upper case. */
const methodSchema = z
  .union([z.string(), z.array(z.string()).min(1)])
  .transform((value) => (Array.isArray(value) ? value : [value]).map((method) => method.toUpperCase()));

/** An RFC 6902 operation. `path` is a JSON Pointer: either `""` or `/a/0/b`. */
const jsonPatchOperationSchema = z.strictObject({
  op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
  path: z.string().refine((p) => p === '' || p.startsWith('/'), 'a JSON Pointer must be empty or start with "/"'),
  from: z.string().optional(),
  value: z.unknown().optional(),
});

export type JsonPatchOperation = z.infer<typeof jsonPatchOperationSchema>;

/**
 * Short circuit: reply without ever contacting the server.
 * The short form `respond: ./file.json` is equivalent to `respond: { file: ./file.json }`.
 */
const respondSchema = z
  .union([
    z.string(),
    z.strictObject({
      file: z.string().optional(),
      body: z.unknown().optional(),
      status: statusSchema.optional(),
      headers: headersSchema.optional(),
      delay: delaySchema.optional(),
    }),
  ])
  .transform((value) => (typeof value === 'string' ? { file: value } : value))
  .refine(
    (value) => !(value.file !== undefined && value.body !== undefined),
    '`respond`: `file` and `body` are mutually exclusive',
  );

export type RespondAction = z.infer<typeof respondSchema>;

/** Changes applied to the real response coming back from the server. */
const patchSchema = z
  .strictObject({
    status: statusSchema.optional(),
    headers: headersSchema.optional(),
    replaceHeaders: headersSchema.optional(),
    merge: z.record(z.string(), z.unknown()).optional(),
    jsonPatch: z.array(jsonPatchOperationSchema).min(1).optional(),
    body: z.unknown().optional(),
    file: z.string().optional(),
    delay: delaySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '`patch` cannot be empty')
  .refine(
    (value) => !(value.file !== undefined && value.body !== undefined),
    '`patch`: `file` and `body` are mutually exclusive',
  )
  .refine(
    (value) => !(value.headers !== undefined && value.replaceHeaders !== undefined),
    '`patch`: `headers` (merge) and `replaceHeaders` (replace) are mutually exclusive',
  );

export type PatchAction = z.infer<typeof patchSchema>;

/** Rewrites applied to the request before it reaches the server. */
const requestSchema = z
  .strictObject({
    host: z.string().optional(),
    path: z.string().optional(),
    method: z.string().optional(),
    query: z.record(z.string(), z.string()).optional(),
    headers: headersSchema.optional(),
    removeHeaders: z.array(z.string()).min(1).optional(),
    body: z.unknown().optional(),
    merge: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '`request` cannot be empty')
  .refine(
    (value) => !(value.body !== undefined && value.merge !== undefined),
    '`request`: `body` and `merge` are mutually exclusive',
  );

export type RequestAction = z.infer<typeof requestSchema>;

const ruleSchema = z
  .strictObject({
    name: z.string().optional(),
    host: z.string().optional(),
    method: methodSchema.optional(),
    path: z.string().optional(),
    pathRegex: z.string().optional(),
    query: z.record(z.string(), z.string()).optional(),
    respond: respondSchema.optional(),
    patch: patchSchema.optional(),
    request: requestSchema.optional(),
  })
  .refine((rule) => !(rule.respond && rule.patch), '`respond` and `patch` are mutually exclusive')
  .refine(
    (rule) => !(rule.respond && rule.request),
    '`respond` short circuits the request, so `request` would be a no-op',
  )
  .refine((rule) => rule.respond || rule.patch || rule.request, 'a rule must define `respond`, `patch` or `request`')
  .refine((rule) => !(rule.path && rule.pathRegex), '`path` and `pathRegex` are mutually exclusive');

export type Rule = z.infer<typeof ruleSchema>;

const upstreamSchema = z.union([z.literal('auto'), z.literal('off'), z.url()]);

export const configSchema = z.strictObject({
  /** Default host for every rule that does not declare one. */
  host: z.string().optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  /** `auto` inherits `HTTPS_PROXY` from the environment, `off` forces a direct connection. */
  upstream: upstreamSchema.default('auto'),
  /**
   * Hosts the target tool should reach without going through jean-claude.
   * Empty by default: excluding loopback would silently skip localhost targets.
   */
  noProxy: z.array(z.string()).optional(),
  /** Hosts tunnelled without interception, for clients that pin certificates. */
  tlsPassthrough: z.array(z.string()).optional(),
  /**
   * Where `run` writes its own log, relative to this file. The literal
   * `terminal` keeps it interleaved with the target's output.
   */
  logFile: z.string().optional(),
  rules: z.array(ruleSchema).default([]),
});

export type Config = z.infer<typeof configSchema>;
