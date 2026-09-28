import net from 'node:net';

import type { Mockttp } from 'mockttp';

/** Where the proxy listens unless `--host` says otherwise: this machine only. */
export const DEFAULT_HOST = '127.0.0.1';

/** Whether only this machine can connect to a socket bound to `address`. */
export function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/**
 * The URL the target tool should use to reach a proxy bound to `address`.
 *
 * A wildcard bind is reached through 127.0.0.1 - rather than localhost, which
 * some clients resolve to ::1 only - and an IPv6 literal needs its brackets.
 */
export function proxyUrlFor(address: string, port: number): string {
  if (address === '0.0.0.0' || address === '::') return `http://127.0.0.1:${port}`;
  return net.isIPv6(address) ? `http://[${address}]:${port}` : `http://${address}:${port}`;
}

/**
 * Starts mockttp listening on `host`, and returns the address actually bound.
 *
 * mockttp takes no listen address: `start()` ends in a bare `server.listen(port)`,
 * which Node binds to every interface - an open, TLS-intercepting proxy for
 * anyone on the network. So `listen` is steered for the duration of `start()`,
 * the only window in which mockttp makes that call (a port collision retries
 * inside it). Only a call naming a port and no address is touched: get-port's
 * availability probes pass an options object and go through unchanged.
 */
export async function startListening(proxy: Mockttp, port: number | undefined, host: string): Promise<string> {
  const listen = net.Server.prototype.listen;
  let server: net.Server | undefined;

  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
    if (typeof args[0] === 'number' && (args.length === 1 || typeof args[1] === 'function')) {
      server = Reflect.apply(listen, this, [args[0], host, ...args.slice(1)]) as net.Server;
      return server;
    }
    return Reflect.apply(listen, this, args) as net.Server;
  } as typeof listen;

  try {
    await proxy.start(port);
  } finally {
    net.Server.prototype.listen = listen;
  }

  // Fail closed: should a mockttp upgrade listen some other way, refuse to run
  // wide open rather than silently ignore the requested address.
  const bound = server?.address();
  if (bound === null || bound === undefined || typeof bound === 'string') {
    await proxy.stop();
    throw new Error(`could not bind the proxy to ${host} - mockttp no longer listens the way jean-claude expects.`);
  }
  return bound.address;
}
