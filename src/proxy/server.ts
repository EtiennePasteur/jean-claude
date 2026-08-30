import { getLocal } from 'mockttp';

import type { CaPaths } from '../ca/store.ts';
import type { LoadedConfig } from '../config/load.ts';
import type { UpstreamSettings } from '../env/upstream.ts';
import type { Reporter } from '../log/reporter.ts';
import type { Recorder } from '../record/writer.ts';
import { type ActionContext, makeBeforeRequest, makeBeforeResponse, makeRespondHandler } from './actions.ts';
import { factsFromUrl } from './match.ts';

export interface StartProxyOptions {
  loaded: LoadedConfig;
  ca: CaPaths;
  /** Upstream proxy for relayed traffic, when jean-claude sits behind one. */
  upstream: UpstreamSettings | undefined;
  /** Certificates jean-claude itself must trust when relaying, as PEM text. */
  outboundTrust: string | undefined;
  reporter: Reporter;
  recorder: Recorder | undefined;
  port: number | undefined;
}

/** Payload of mockttp's `passthrough-abort` rule event. */
interface PassthroughAbortEvent {
  error: { name?: string; code?: string; message?: string };
}

export interface RunningProxy {
  /** Proxy URL to hand to the target tool. */
  url: string;
  port: number;
  /** Swap in a new config without dropping the listening socket. */
  reload: (loaded: LoadedConfig) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Options shared by every passthrough: where to send relayed traffic, and which
 * extra authorities to trust on the way out.
 *
 * `additionalTrustedCAs` is not additive on the Node side: mockttp turns it into
 * an explicit `ca` list (its own bundled roots plus ours), and `ca` *replaces*
 * the default store. So this has to carry the OS trust store as well as the
 * corporate CA, or passing a corporate CA would narrow the trust set instead of
 * widening it.
 */
function buildConnectionOptions({ upstream, outboundTrust }: Pick<StartProxyOptions, 'upstream' | 'outboundTrust'>) {
  return {
    ...(upstream !== undefined
      ? {
          proxyConfig: {
            proxyUrl: upstream.proxyUrl,
            ...(upstream.noProxy !== undefined ? { noProxy: upstream.noProxy } : {}),
          },
        }
      : {}),
    ...(outboundTrust !== undefined ? { additionalTrustedCAs: [{ cert: outboundTrust }] } : {}),
  };
}

export async function startProxy(options: StartProxyOptions): Promise<RunningProxy> {
  const { ca, reporter } = options;
  let loaded = options.loaded;
  const initialTlsPassthrough = loaded.config.tlsPassthrough ?? [];

  const proxy = getLocal({
    https: {
      keyPath: ca.keyPath,
      certPath: ca.certPath,
      tlsPassthrough: initialTlsPassthrough.map((hostname) => ({ hostname })),
    },
    // Fall back to HTTP/1.1 when the target does not negotiate h2.
    http2: 'fallback',
    // Bodies are buffered on demand by our own callbacks; there is no need to
    // also retain every exchange for getSeenRequests().
    recordTraffic: false,
  });

  const connection = buildConnectionOptions(options);

  async function attachListeners(): Promise<void> {
    await proxy.on('request', (request) => reporter.seen(request.id, request.method, request.url));
    await proxy.on('response', (response) => reporter.response(response.id, response.statusCode));
    await proxy.on('abort', (request) => reporter.aborted(request.id, request.error?.message));
    await proxy.on('tls-client-error', (failure) =>
      reporter.tlsError(failure.tlsMetadata.sniHostname ?? failure.destination?.hostname),
    );
    // A failed relay fires neither `response` nor `abort`: mockttp answers the
    // client with a 500 and logs a bare one-liner that names neither the request
    // nor the host. This is the only hook that carries both.
    await proxy.on<PassthroughAbortEvent>('rule-event', (event) => {
      if (event.eventType !== 'passthrough-abort') return;
      reporter.upstreamFailed(event.requestId, event.eventData.error);
    });
  }

  async function registerRules(): Promise<void> {
    const ctx: ActionContext = { baseDir: loaded.baseDir, reporter, recorder: options.recorder };

    // Rules are registered in file order: mockttp uses the first one that matches.
    for (const compiled of loaded.rules) {
      const builder = proxy
        .forAnyRequest()
        .matching((request) => compiled.match(factsFromUrl(request.url, request.method)).matched);

      if (compiled.rule.respond !== undefined) {
        await builder.thenCallback(makeRespondHandler(compiled, ctx));
      } else {
        await builder.thenPassThrough({
          ...connection,
          beforeRequest: makeBeforeRequest(compiled, ctx),
          beforeResponse: makeBeforeResponse(compiled, ctx),
        });
      }
    }

    // Safety net: anything else is still decrypted, logged, and relayed untouched.
    await proxy.forUnmatchedRequest().thenPassThrough({
      ...connection,
      beforeRequest: makeBeforeRequest(undefined, ctx),
      beforeResponse: makeBeforeResponse(undefined, ctx),
    });
  }

  await proxy.start(options.port ?? loaded.config.port);
  await attachListeners();
  await registerRules();

  return {
    // 127.0.0.1 rather than localhost: some clients resolve localhost to ::1 only.
    url: `http://127.0.0.1:${proxy.port}`,
    port: proxy.port,

    reload: async (next) => {
      loaded = next;
      const nextTlsPassthrough = next.config.tlsPassthrough ?? [];
      if (nextTlsPassthrough.join(',') !== initialTlsPassthrough.join(',')) {
        reporter.warn('`tlsPassthrough` changed - restart jean-claude for it to take effect.');
      }
      // reset() drops rules *and* subscriptions, so listeners must be re-attached.
      proxy.reset();
      await attachListeners();
      await registerRules();
    },

    stop: () => proxy.stop(),
  };
}
