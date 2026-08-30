import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { configSchema } from '../src/config/schema.ts';
import {
  buildChildEnv,
  formatShellExports,
  nodeSupportsEnvProxy,
  proxyEnvUnset,
  proxyEnvVars,
} from '../src/env/child.ts';
import { detectUpstream, inheritedExtraCaCerts } from '../src/env/upstream.ts';
import { capturePathFor } from '../src/record/writer.ts';

const OPTIONS = { proxyUrl: 'http://127.0.0.1:8888', bundlePath: '/home/me/.config/jean-claude/ca/bundle.pem' };

describe('proxyEnvVars', () => {
  it('sets the proxy in both cases', () => {
    const vars = proxyEnvVars(OPTIONS);
    expect(vars.HTTPS_PROXY).toBe(OPTIONS.proxyUrl);
    expect(vars.https_proxy).toBe(OPTIONS.proxyUrl);
    expect(vars.HTTP_PROXY).toBe(OPTIONS.proxyUrl);
  });

  it('opts Node into reading the proxy variables', () => {
    expect(proxyEnvVars(OPTIONS).NODE_USE_ENV_PROXY).toBe('1');
  });

  it('points every CA variable at the bundle, not at the bare CA', () => {
    const vars = proxyEnvVars(OPTIONS);
    for (const name of [
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'CURL_CA_BUNDLE',
      'REQUESTS_CA_BUNDLE',
      'AWS_CA_BUNDLE',
      'GIT_SSL_CAINFO',
    ]) {
      expect(vars[name]).toBe(OPTIONS.bundlePath);
    }
  });

  it('sets no exclusion by default, so localhost targets are intercepted too', () => {
    const vars = proxyEnvVars(OPTIONS);
    expect(vars.NO_PROXY).toBeUndefined();
    expect(vars.no_proxy).toBeUndefined();
    expect(proxyEnvUnset(OPTIONS)).toEqual(['NO_PROXY', 'no_proxy']);
  });

  it('strips an inherited NO_PROXY, which would silently bypass the proxy', () => {
    const env = buildChildEnv({ NO_PROXY: 'localhost', no_proxy: 'localhost', PATH: '/usr/bin' }, OPTIONS);
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('honours explicit exclusions from the config', () => {
    const options = { ...OPTIONS, noProxy: ['api.internal', 'metrics.local'] };
    const env = buildChildEnv({ NO_PROXY: 'stale' }, options);
    expect(env.NO_PROXY).toBe('api.internal,metrics.local');
    expect(env.no_proxy).toBe('api.internal,metrics.local');
    expect(proxyEnvUnset(options)).toEqual([]);
  });

  it('treats a list of blank entries as no exclusion at all', () => {
    const options = { ...OPTIONS, noProxy: ['  ', ''] };
    expect(proxyEnvVars(options).NO_PROXY).toBeUndefined();
    expect(proxyEnvUnset(options)).toEqual(['NO_PROXY', 'no_proxy']);
  });
});

describe('nodeSupportsEnvProxy', () => {
  it.each([
    ['24.18.0', true],
    ['24.5.0', true],
    ['24.4.1', false],
    ['23.11.0', false],
    ['22.21.0', true],
    ['22.20.0', false],
    ['20.19.0', false],
    ['25.0.0', true],
  ])('%s -> %s', (version, expected) => {
    expect(nodeSupportsEnvProxy(version)).toBe(expected);
  });
});

describe('formatShellExports', () => {
  it('quotes the values and escapes single quotes', () => {
    expect(formatShellExports({ A: 'x' })).toBe("export A='x'");
    expect(formatShellExports({ A: "it's" })).toContain("it'\\''s");
  });

  it('appends an unset line for the variables that must be removed', () => {
    expect(formatShellExports({ A: 'x' }, ['NO_PROXY', 'no_proxy'])).toBe("export A='x'\nunset NO_PROXY no_proxy");
  });
});

describe('detectUpstream', () => {
  const auto = configSchema.parse({});

  it('inherits HTTPS_PROXY from the environment', () => {
    const upstream = detectUpstream(auto, { HTTPS_PROXY: 'http://corp:3128' });
    expect(upstream).toEqual({ proxyUrl: 'http://corp:3128', noProxy: undefined, source: 'env' });
  });

  it('falls back to HTTP_PROXY', () => {
    expect(detectUpstream(auto, { HTTP_PROXY: 'http://corp:3128' })?.proxyUrl).toBe('http://corp:3128');
  });

  it('parses NO_PROXY into a list', () => {
    const upstream = detectUpstream(auto, { HTTPS_PROXY: 'http://corp:3128', NO_PROXY: 'a.com, b.com ,' });
    expect(upstream?.noProxy).toEqual(['a.com', 'b.com']);
  });

  it('returns nothing when the environment is clean', () => {
    expect(detectUpstream(auto, {})).toBeUndefined();
  });

  it('honours `upstream: off` even when the environment has a proxy', () => {
    const config = configSchema.parse({ upstream: 'off' });
    expect(detectUpstream(config, { HTTPS_PROXY: 'http://corp:3128' })).toBeUndefined();
  });

  it('lets an explicit config URL win over the environment', () => {
    const config = configSchema.parse({ upstream: 'http://chosen:8080' });
    const upstream = detectUpstream(config, { HTTPS_PROXY: 'http://corp:3128' });
    expect(upstream).toMatchObject({ proxyUrl: 'http://chosen:8080', source: 'config' });
  });

  it('ignores a blank proxy variable', () => {
    expect(detectUpstream(auto, { HTTPS_PROXY: '   ' })).toBeUndefined();
  });
});

describe('inheritedExtraCaCerts', () => {
  it('picks up the corporate CA', () => {
    expect(inheritedExtraCaCerts({ NODE_EXTRA_CA_CERTS: '/etc/corp.pem' })).toBe('/etc/corp.pem');
  });

  it('ignores an unset or blank value', () => {
    expect(inheritedExtraCaCerts({})).toBeUndefined();
    expect(inheritedExtraCaCerts({ NODE_EXTRA_CA_CERTS: '  ' })).toBeUndefined();
  });
});

describe('capturePathFor', () => {
  it('mirrors the URL into a directory tree', () => {
    expect(capturePathFor('/cap', 'https://api.y.com/api/todos', 'get', 'json')).toBe(
      '/cap/api.y.com/api/todos.GET.json',
    );
  });

  it('names a root request `index`', () => {
    expect(capturePathFor('/cap', 'https://api.y.com/', 'GET', 'json')).toBe('/cap/api.y.com/index.GET.json');
  });

  it('distinguishes two requests that differ only by their query', () => {
    const a = capturePathFor('/cap', 'https://y.com/s?q=1', 'GET', 'json');
    const b = capturePathFor('/cap', 'https://y.com/s?q=2', 'GET', 'json');
    expect(a).not.toBe(b);
    expect(a).toMatch(/\/s-[0-9a-f]{8}\.GET\.json$/);
  });

  it('never escapes the capture directory', () => {
    // `%2F` survives URL parsing, so a segment can still look like a traversal.
    const encoded = capturePathFor('/cap', 'https://y.com/a/..%2F..%2Fetc/passwd', 'GET', 'json');
    // ...and a literal `..` segment, which URL parsing would normally collapse.
    const literal = capturePathFor('/cap', 'https://y.com/..', 'GET', 'json');

    for (const target of [encoded, literal]) {
      expect(path.resolve(target).startsWith('/cap/')).toBe(true);
      expect(path.resolve(target)).toBe(target);
      expect(target.split('/')).not.toContain('..');
    }
  });
});
