import { describe, expect, it } from 'vitest';

import { configSchema } from '../src/config/schema.ts';
import { compileMatcher, factsFromUrl, interpolate } from '../src/proxy/match.ts';

/** Build a matcher from a config fragment, going through the schema. */
function matcherFor(raw: unknown): ReturnType<typeof compileMatcher> {
  const config = configSchema.parse(raw);
  const rule = config.rules[0]!;
  return compileMatcher(rule, config, 0);
}

const RESPOND = { respond: './x.json' };

describe('compileMatcher - host', () => {
  it('matches any host when none is declared', () => {
    const match = matcherFor({ rules: [{ path: '/api/todos', ...RESPOND }] });
    expect(match(factsFromUrl('https://api.y.com/api/todos', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://other.z.org/api/todos', 'GET')).matched).toBe(true);
  });

  it('applies the file-level default host', () => {
    const match = matcherFor({ host: 'api.y.com', rules: [{ path: '/api/todos', ...RESPOND }] });
    expect(match(factsFromUrl('https://api.y.com/api/todos', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://other.z.org/api/todos', 'GET')).matched).toBe(false);
  });

  it('lets a rule override the default host', () => {
    const match = matcherFor({
      host: 'api.y.com',
      rules: [{ host: 'auth.y.com', path: '/oauth/token', ...RESPOND }],
    });
    expect(match(factsFromUrl('https://auth.y.com/oauth/token', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://api.y.com/oauth/token', 'GET')).matched).toBe(false);
  });

  it('ignores host casing', () => {
    const match = matcherFor({ host: 'API.Y.com', rules: [{ path: '/a', ...RESPOND }] });
    expect(match(factsFromUrl('https://api.y.COM/a', 'GET')).matched).toBe(true);
  });

  it('accepts a subdomain wildcard', () => {
    const match = matcherFor({ host: '*.y.com', rules: [{ path: '/a', ...RESPOND }] });
    expect(match(factsFromUrl('https://api.y.com/a', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://deep.api.y.com/a', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://y.com/a', 'GET')).matched).toBe(false);
    expect(match(factsFromUrl('https://noty.com/a', 'GET')).matched).toBe(false);
  });
});

describe('compileMatcher - method', () => {
  it('matches every method by default', () => {
    const match = matcherFor({ rules: [{ path: '/a', ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/a', 'DELETE')).matched).toBe(true);
  });

  it('filters on a method, case-insensitively', () => {
    const match = matcherFor({ rules: [{ path: '/a', method: 'get', ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/a', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://y.com/a', 'POST')).matched).toBe(false);
  });

  it('accepts a list of methods', () => {
    const match = matcherFor({ rules: [{ path: '/a', method: ['POST', 'PUT'], ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/a', 'PUT')).matched).toBe(true);
    expect(match(factsFromUrl('https://y.com/a', 'GET')).matched).toBe(false);
  });
});

describe('compileMatcher - path', () => {
  it('matches an exact path and nothing else', () => {
    const match = matcherFor({ rules: [{ path: '/api/todos', ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/api/todos', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://y.com/api/todos/1', 'GET')).matched).toBe(false);
    expect(match(factsFromUrl('https://y.com/api', 'GET')).matched).toBe(false);
  });

  it('ignores the query string when matching the path', () => {
    const match = matcherFor({ rules: [{ path: '/api/todos', ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/api/todos?page=2', 'GET')).matched).toBe(true);
  });

  it('captures a named parameter', () => {
    const match = matcherFor({ rules: [{ path: '/api/users/:id', ...RESPOND }] });
    const result = match(factsFromUrl('https://y.com/api/users/42', 'GET'));
    expect(result.matched).toBe(true);
    expect(result.params).toEqual({ id: '42' });
  });

  it('accepts a bare `*` wildcard', () => {
    const match = matcherFor({ rules: [{ path: '/api/*', ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/api/a/b/c', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://other.com/nope', 'GET')).matched).toBe(false);
  });

  it('matches every URL when `path` is absent', () => {
    const match = matcherFor({ rules: [{ method: 'POST', ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/any/thing', 'POST')).matched).toBe(true);
  });

  it('supports `pathRegex`', () => {
    const match = matcherFor({ rules: [{ pathRegex: '^/api/v[0-9]+/todos$', ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/api/v2/todos', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://y.com/api/vX/todos', 'GET')).matched).toBe(false);
  });

  it('rejects an invalid path pattern at compile time', () => {
    expect(() => matcherFor({ rules: [{ path: '/api/:', ...RESPOND }] })).toThrow(/invalid `path` pattern/);
  });
});

describe('compileMatcher - query', () => {
  it('requires the declared parameters and ignores the others', () => {
    const match = matcherFor({ rules: [{ path: '/search', query: { q: 'todo' }, ...RESPOND }] });
    expect(match(factsFromUrl('https://y.com/search?q=todo', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://y.com/search?q=todo&page=2', 'GET')).matched).toBe(true);
    expect(match(factsFromUrl('https://y.com/search?q=other', 'GET')).matched).toBe(false);
    expect(match(factsFromUrl('https://y.com/search', 'GET')).matched).toBe(false);
  });
});

describe('interpolate', () => {
  it('substitutes captured parameters', () => {
    expect(interpolate('./stubs/{id}.json', { id: '42' })).toBe('./stubs/42.json');
  });

  it('leaves an unknown parameter untouched', () => {
    expect(interpolate('./stubs/{nope}.json', { id: '42' })).toBe('./stubs/{nope}.json');
  });
});
