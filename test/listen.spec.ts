import { describe, expect, it } from 'vitest';

import { isLoopback, proxyUrlFor } from '../src/proxy/listen.ts';

describe('proxyUrlFor', () => {
  it('reaches a wildcard bind through 127.0.0.1', () => {
    expect(proxyUrlFor('0.0.0.0', 8888)).toBe('http://127.0.0.1:8888');
    expect(proxyUrlFor('::', 8888)).toBe('http://127.0.0.1:8888');
  });

  it('uses a specific address as is', () => {
    expect(proxyUrlFor('127.0.0.1', 8888)).toBe('http://127.0.0.1:8888');
    expect(proxyUrlFor('192.168.1.20', 8888)).toBe('http://192.168.1.20:8888');
  });

  it('brackets an IPv6 literal', () => {
    expect(proxyUrlFor('::1', 8888)).toBe('http://[::1]:8888');
    expect(proxyUrlFor('fe80::1', 8888)).toBe('http://[fe80::1]:8888');
  });
});

describe('isLoopback', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])('%s is loopback', (address) => {
    expect(isLoopback(address)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', 'fe80::1'])('%s is not', (address) => {
    expect(isLoopback(address)).toBe(false);
  });
});
