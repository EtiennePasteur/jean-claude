import pc from 'picocolors';

/** What jean-claude did with a request. */
export type ActionKind = 'stub' | 'patch' | 'rewrite' | 'passthrough';

interface Entry {
  method?: string;
  url?: string;
  kind?: ActionKind;
  label?: string;
  detail?: string;
  recorded?: string;
}

/**
 * OpenSSL verification failures, as opposed to the dozens of other ways a relay
 * can die. They all mean the same thing operationally: jean-claude was not given
 * the authority that signed what it was talking to.
 */
const TRUST_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
]);

const KIND_LABELS: Record<ActionKind, string> = {
  stub: 'stub',
  patch: 'patched',
  rewrite: 'rewritten',
  passthrough: 'passthrough',
};

function colorStatus(status: number): string {
  const text = String(status);
  if (status >= 500) return pc.red(text);
  if (status >= 400) return pc.yellow(text);
  if (status >= 300) return pc.cyan(text);
  return pc.green(text);
}

function shortTarget(url: string | undefined): string {
  if (url === undefined) return '(unknown url)';
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Console log. One line per request, emitted on response so that the status
 * actually delivered to the client can be shown.
 */
export class Reporter {
  private readonly entries = new Map<string, Entry>();
  /** The trust hint is the same every time; once per run is enough. */
  private trustHintShown = false;
  /**
   * Counted even under `--quiet`, and even when the log went to a file: the
   * summary is the only thing a redirected run says on the terminal.
   */
  private readonly counts = { requests: 0, ruleHits: 0, upstreamErrors: 0 };
  /**
   * Requests already reported as an upstream failure. mockttp still hands the
   * client a synthetic 502 afterwards, which would otherwise show up as a second
   * line - with no method and no URL, since the entry is already gone - and
   * count the same request twice.
   */
  private readonly failed = new Set<string>();

  constructor(private readonly options: { verbose: boolean; quiet: boolean }) {}

  /** Merging upsert, so we do not depend on the order of the `request` event vs the rules. */
  private upsert(id: string, patch: Entry): void {
    this.entries.set(id, { ...this.entries.get(id), ...patch });
  }

  seen(id: string, method: string, url: string): void {
    this.upsert(id, { method, url });
  }

  action(id: string, kind: ActionKind, label?: string, detail?: string): void {
    if (kind !== 'passthrough') this.counts.ruleHits += 1;
    this.upsert(id, { kind, label, detail });
  }

  recorded(id: string, filePath: string): void {
    this.upsert(id, { recorded: filePath });
  }

  response(id: string, statusCode: number): void {
    if (this.failed.delete(id)) return;

    const entry = this.entries.get(id) ?? {};
    this.entries.delete(id);
    this.counts.requests += 1;
    if (this.options.quiet) return;

    // Without `--verbose`, unaffected traffic stays out of the console.
    const isPlainPassthrough = (entry.kind ?? 'passthrough') === 'passthrough' && entry.recorded === undefined;
    if (isPlainPassthrough && !this.options.verbose) return;

    console.log(
      `  ${pad(entry.method ?? '???', 6)}${pad(truncate(shortTarget(entry.url), 52), 54)}` +
        `${colorStatus(statusCode)}${this.describeAction(entry)}`,
    );
  }

  private describeAction(entry: Entry): string {
    const parts: string[] = [];
    if (entry.kind !== undefined && entry.kind !== 'passthrough') {
      const detail = entry.detail !== undefined ? ` ${pc.dim(entry.detail)}` : '';
      parts.push(`${pc.magenta('→')} ${KIND_LABELS[entry.kind]}${detail}`);
    }
    if (entry.recorded !== undefined) {
      parts.push(`${pc.blue('⇒')} ${pc.dim(entry.recorded)}`);
    }
    return parts.length > 0 ? `  ${parts.join('  ')}` : '';
  }

  aborted(id: string, reason?: string): void {
    const entry = this.entries.get(id) ?? {};
    this.entries.delete(id);
    this.counts.requests += 1;
    if (this.options.quiet) return;
    const detail = reason !== undefined ? ` ${pc.dim(`(${reason})`)}` : '';
    console.log(
      `  ${pad(entry.method ?? '???', 6)}${pad(truncate(shortTarget(entry.url), 52), 54)}${pc.red('aborted')}${detail}`,
    );
  }

  /**
   * jean-claude reached the target but could not talk to the real server. Worth
   * a line of its own: the client is handed a 502 it did not ask for, and the
   * reason lives on the relay leg, which neither `response` nor `abort` covers.
   */
  upstreamFailed(id: string, error: { code?: string; message?: string }): void {
    const entry = this.entries.get(id) ?? {};
    this.entries.delete(id);
    this.failed.add(id);
    this.counts.requests += 1;
    this.counts.upstreamErrors += 1;
    if (this.options.quiet) return;

    const reason = error.code ?? error.message ?? 'unknown error';
    console.log(
      `  ${pad(entry.method ?? '???', 6)}${pad(truncate(shortTarget(entry.url), 52), 54)}` +
        `${pc.red('upstream')}  ${pc.dim(reason)}`,
    );

    if (TRUST_ERROR_CODES.has(error.code ?? '') && !this.trustHintShown) {
      this.trustHintShown = true;
      this.warn(
        "jean-claude could not verify the real server's certificate. On the way out it trusts the OS " +
          'certificate store plus NODE_EXTRA_CA_CERTS - if your network intercepts TLS with a CA that is ' +
          'in neither, export that CA and point NODE_EXTRA_CA_CERTS at it before running jean-claude.',
      );
    }
  }

  /**
   * A client-side TLS failure almost always means the target pins its
   * certificates. Say so, rather than leaving the user to guess.
   */
  tlsError(hostname: string | undefined): void {
    if (this.options.quiet) return;
    const where = hostname ?? 'unknown host';
    this.warn(
      `TLS handshake with ${where} failed - the target rejected jean-claude's CA ` +
        `(certificate pinning?). Add "tlsPassthrough: [${where}]" to the config to tunnel it untouched.`,
    );
  }

  /**
   * What happened, in one line, `undefined` when nothing did.
   *
   * This is what a run whose log went to a file gets to say on the terminal, so
   * a redirect never reads as "jean-claude did nothing".
   */
  summary(): string | undefined {
    const { requests, ruleHits, upstreamErrors } = this.counts;
    if (requests === 0) return undefined;

    const parts = [plural(requests, 'request')];
    if (ruleHits > 0) parts.push(`${plural(ruleHits, 'rule hit')}`);
    if (upstreamErrors > 0) parts.push(pc.red(plural(upstreamErrors, 'upstream error')));
    return parts.join(', ');
  }

  banner(lines: [string, string][]): void {
    if (this.options.quiet) return;
    const width = Math.max(...lines.map(([key]) => key.length));
    for (const [key, value] of lines) {
      console.log(`  ${pc.dim(pad(key, width + 2))}${value}`);
    }
    console.log('');
  }

  info(message: string): void {
    if (!this.options.quiet) console.log(`  ${message}`);
  }

  warn(message: string): void {
    console.warn(`  ${pc.yellow('!')} ${message}`);
  }
}
