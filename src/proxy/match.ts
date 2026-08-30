import { match as compilePath } from 'path-to-regexp';

import type { Config, Rule } from '../config/schema.ts';

/**
 * The facts about a request that matching depends on. Kept separate from
 * mockttp's types so matching stays testable without starting a server.
 */
export interface RequestFacts {
  hostname: string;
  method: string;
  pathname: string;
  query: URLSearchParams;
}

export interface MatchResult {
  matched: boolean;
  /** Parameters captured by `path` (`:id`, `*splat`), interpolable into `respond.file`. */
  params: Record<string, string>;
}

const NO_MATCH: MatchResult = { matched: false, params: {} };

/**
 * `path-to-regexp` v8 requires wildcards to be named. We accept the natural
 * `/api/*` form by naming them on the fly, so users need not learn `*splat`.
 */
function nameBareWildcards(pattern: string): string {
  let counter = 0;
  return pattern.replaceAll(/\*(?![A-Za-z_])/g, () => `*wildcard${counter++}`);
}

function compilePathMatcher(
  pattern: string,
  ruleLabel: string,
): (pathname: string) => Record<string, string> | undefined {
  let matcher: ReturnType<typeof compilePath>;
  try {
    matcher = compilePath(nameBareWildcards(pattern), { decode: decodeURIComponent });
  } catch (cause) {
    throw new Error(`${ruleLabel}: invalid \`path\` pattern "${pattern}" — ${(cause as Error).message}`, { cause });
  }

  return (pathname) => {
    const result = matcher(pathname);
    if (!result) return undefined;

    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.params)) {
      if (value !== undefined) params[key] = Array.isArray(value) ? value.join('/') : value;
    }
    return params;
  };
}

/** `api.y.com` matches exactly; `*.y.com` matches any subdomain. */
function hostMatches(expected: string, actual: string): boolean {
  const wanted = expected.toLowerCase();
  const got = actual.toLowerCase();
  if (wanted.startsWith('*.')) {
    const suffix = wanted.slice(1); // ".y.com"
    return got.endsWith(suffix) && got.length > suffix.length;
  }
  return wanted === got;
}

export function describeRule(rule: Rule, index: number): string {
  return rule.name ?? `rule #${index + 1} (${rule.path ?? rule.pathRegex ?? 'any URL'})`;
}

/**
 * Compile a rule into a predicate. Patterns are compiled once, at config load
 * time, so broken patterns surface before the proxy starts.
 */
export function compileMatcher(rule: Rule, config: Config, index: number): (facts: RequestFacts) => MatchResult {
  const label = describeRule(rule, index);
  const expectedHost = rule.host ?? config.host;
  const expectedMethods = rule.method;
  const matchPath = rule.path !== undefined ? compilePathMatcher(rule.path, label) : undefined;
  const pathRegex = rule.pathRegex !== undefined ? new RegExp(rule.pathRegex) : undefined;
  const expectedQuery = rule.query ? Object.entries(rule.query) : undefined;

  return (facts) => {
    if (expectedHost !== undefined && !hostMatches(expectedHost, facts.hostname)) return NO_MATCH;
    if (expectedMethods !== undefined && !expectedMethods.includes(facts.method.toUpperCase())) return NO_MATCH;
    if (pathRegex !== undefined && !pathRegex.test(facts.pathname)) return NO_MATCH;
    if (expectedQuery !== undefined && !expectedQuery.every(([key, value]) => facts.query.get(key) === value)) {
      return NO_MATCH;
    }

    if (matchPath !== undefined) {
      const params = matchPath(facts.pathname);
      if (params === undefined) return NO_MATCH;
      return { matched: true, params };
    }

    return { matched: true, params: {} };
  };
}

/** Derive the matching facts from an absolute URL. */
export function factsFromUrl(url: string, method: string): RequestFacts {
  const parsed = new URL(url);
  return {
    hostname: parsed.hostname,
    method,
    pathname: parsed.pathname,
    query: parsed.searchParams,
  };
}

/** Interpolate captured parameters into a file path: `./stubs/{id}.json`. */
export function interpolate(template: string, params: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (whole, key: string) => params[key] ?? whole);
}
