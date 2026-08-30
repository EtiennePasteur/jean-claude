# CLAUDE.md

Guidance for Claude Code when working in this repository.

`jean-claude` is a CLI MITM HTTPS proxy: it intercepts another tool's API traffic
and rewrites it from a YAML file. See `README.md` for user-facing behaviour and
the config format — this file covers how to work on the code.

**It is a general-purpose tool, not a Claude Code utility.** The README presents
it that way on purpose: any HTTPS client honouring the proxy env vars is a valid
target, and freezing Claude Code's managed settings (`init --claude-code`) is one
worked example of `respond:`, kept because it is the rule the author runs daily.
Keep new docs and error messages neutral.

**Everything in this project is written in English**: code, comments, error
messages, docs, commit messages, test names.

## Commands

```bash
npm test                 # vitest run - 155 tests, ~0.9s
npm run test:watch
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run format           # prettier --write
npm run format:check     # prettier --check (what CI wants)
npm run build            # tsdown -> dist/cli.mjs
npm run jc -- --help     # run the CLI from source (tsx)
```

## Architecture

```
src/
  cli.ts              commander wiring: run | start | env | ca | check | init
  commands/
    shared.ts         openSession(): config + CA + upstream + proxy + hot reload
    run.ts            execa spawn with the injected env; exits with the child's code
    start.ts          foreground daemon; writes the session file
    env.ts            prints the env for an already running start
    ca.ts check.ts init.ts
  config/
    schema.ts         zod schema - THE source of truth for the config format
    paths.ts          the jean-claude home and everything under it
    load.ts           YAML read, validation, rule compilation
    watch.ts          chokidar -> reload
    template.ts       `init` scaffolding (generic + --claude-code)
  proxy/
    server.ts         getLocal(), lifecycle, listeners, rule registration
    actions.ts        respond / patch / request -> mockttp callbacks
    match.ts          host/method/path/query -> predicate (mockttp-free, unit tested)
  ca/store.ts         CA generation + bundle.pem assembly
  env/
    upstream.ts       reads the inherited HTTPS_PROXY / NODE_EXTRA_CA_CERTS
    child.ts          builds the env injected into the target tool
    session.ts        session.json handoff between `start` and `env`
  record/writer.ts    --record: writes real responses as reusable stubs
  log/
    reporter.ts       one console line per request, plus the exit summary
    sink.ts           --log: sends our own output to a file while a child runs
  util/json.ts        deep merge + RFC 6902 JSON Patch
```

### How rules become mockttp rules

`proxy/server.ts` registers **one mockttp rule per config rule**, in file order,
then a `forUnmatchedRequest()` catch-all. Matching goes through
`.matching(compileMatcher(...))` rather than mockttp's own URL matchers, so all
matching logic lives in `proxy/match.ts` and stays testable without a server.

Actions use mockttp's **imperative callbacks** (`thenCallback`, `beforeRequest`,
`beforeResponse`), not its declarative `transformRequest`/`transformResponse`.
That was a deliberate trade: the declarative path is more idiomatic but is a
static per-rule option, which rules out `delay` on a patched response and forces
two code paths. One imperative path handles every mode uniformly.

`beforeRequest` is installed even on rules that do not rewrite anything, because
that is where a request gets tagged for the log.

## mockttp API notes

Pinned to `mockttp@^4.6.1`. Things that cost time to discover:

- **Callback types are not re-exported from the package root.** `actions.ts`
  derives them from the public `RequestRuleBuilder` type
  (`Parameters<RequestRuleBuilder['thenPassThrough']>[0]`) rather than deep
  importing. Keep it that way — it survives version bumps.
- **`reset()` clears rules _and_ subscriptions.** Hot reload must re-attach the
  `on('request'|'response'|'abort'|'tls-client-error')` listeners after every
  reset. `test/integration.spec.ts` has a test that fails if this regresses.
- **`getCA` is not on the root export** but mockttp's `exports` map publishes
  `./dist/*`, so `import { getCA } from 'mockttp/dist/util/certificates'` works
  (no `.js` suffix). Used in tests only, to mint the fake upstream's leaf.
- `additionalTrustedCAs`, not `trustAdditionalCAs`. `proxyConfig` takes
  `{ proxyUrl, noProxy }`.
- `tlsPassthrough` is a **server construction** option, so changing it needs a
  restart. `reload()` warns when it changes.

## Testing

`test/integration.spec.ts` is the one that matters. It drives the real
`startProxy()` against a fake upstream and asserts the properties that define
correctness:

- a `respond` rule **never reaches the server** (`upstreamHits` stays empty)
- a `patch` rule **does** reach it
- a status-only patch **leaves the body intact** (regression guard: a partial
  callback result used to risk blanking it)

The fake upstream is a plain `node:https` server holding a leaf minted by
jean-claude's own CA. **Do not replace it with a second mockttp instance**: a
mockttp proxy relaying to another mockttp instance stalls ~15.1 s on the first
upstream TLS connection. It is not `http2`, not certificate validation, not DNS,
and not jean-claude — against a real server the relay costs ~25 ms. Using
mockttp there once made the suite take 16.5 s instead of 1.6 s and looked exactly
like a product performance bug.

When timing anything in this area, **run one probe per process**. Probes sharing
a Node process warm the DNS/TLS caches, so only the first is cold — that
confound is what first made `http2: 'fallback'` look guilty.

### Manual verification

Some bugs here are structurally invisible to the test suite, because the harness
sets the proxy explicitly and so bypasses the very environment plumbing under
test. That is how the `NO_PROXY` bug below was found. Run the real binary against
a real server before calling interception work done:

```bash
npm run build
node <path>/dist/cli.mjs init --home /tmp/jc-smoke
# start an https upstream whose leaf is signed by jean-claude's CA
# (see the beforeAll in test/integration.spec.ts for the getCA recipe; if that
# helper lives outside the repo, import mockttp by absolute path -
# `<repo>/node_modules/mockttp/dist/util/certificates.js`, .js suffix included,
# or ESM resolution fails with ERR_MODULE_NOT_FOUND),
# then point the CLI at it, trusting that CA on the way out:
NODE_EXTRA_CA_CERTS=/tmp/jc-smoke/ca/ca.pem \
  node <path>/dist/cli.mjs run --home /tmp/jc-smoke -v --log terminal -- \
  curl -s -w ' [HTTP %{http_code} in %{time_total}s]\n' https://localhost:9443/api/todos
```

`--log terminal` is what keeps the traffic lines on screen: from an interactive
terminal, `run` now writes them to `<home>/jean-claude.log` instead. To exercise
the redirect itself, drop the flag and `cat` the file — and wrap the command in
`script` to get a real pty when the shell you are in is not one, or the TTY
default never fires. **Use the BSD form**, `script -q /dev/null <cmd> <args…>`:
this is macOS, and the GNU form `script -qec '…' /dev/null` fails with
`illegal option -- c`.

Use `--home` (or `XDG_CONFIG_HOME`) for every manual test, or the smoke run will
pick up your real config and CA.

## Decisions to preserve

- **One home directory, `~/.config/jean-claude/`, holding the config, the stubs,
  `ca/` and `session.json`.** Relocated as a whole by `--home`; there is no
  separate `--ca-dir`. Rules are typically _global_ — one config that applies
  wherever you launch the target from — so one path to remember beats XDG's
  config/state split. `config/paths.ts` is the only place that knows the layout.
- **Config discovery falls back to the home, it does not start there.**
  `--config` → walk up from cwd → `<home>/jean-claude.yaml`. A repo can override
  the global rules by dropping its own file at its root. `findConfigFile` takes
  the home as an argument precisely so tests can pin it — without that, a test
  asserting "no config found" passes or fails depending on whether whoever runs
  the suite has a real `~/.config/jean-claude/jean-claude.yaml`.
- **`config/template.ts` is the only copy of the sample config.** There is no
  `examples/` directory: it held the exact bytes of `init --claude-code`, so it
  needed a test purely to keep the duplicate honest. Scaffolding into a throwaway
  home shows the same thing in a second, and the README carries the YAML snippet
  for anyone browsing the repo.
- **`NO_PROXY` is stripped from the child env, never narrowed to loopback.**
  Defaulting it to `localhost,127.0.0.1,::1` reads as prudent but silently makes
  every localhost target bypass interception: the rules do nothing while the
  traffic still looks plausible. Intercepting a local dev API is a primary use
  case. Exclusions are opt-in via `noProxy:` and shown in the banner. Do not put
  `127.0.0.1:<port>` there either — clients that ignore the port would exclude
  all of loopback and reintroduce the bug.
- **The child is pointed at `bundle.pem`, not at the bare CA.** `SSL_CERT_FILE`
  and `CURL_CA_BUNDLE` _replace_ the trust store instead of adding to it, so the
  bundle is our CA + the system store + any inherited corporate CA.
- **The system store is read with `tls.getCACertificates('system')`, not by
  scanning `/etc/ssl/…`.** The file list is only a fallback for Node < 22.15. On
  Windows and macOS the store is an OS API, so the scan finds nothing and we
  would silently fall back to Node's bundled Mozilla roots — dropping every
  administrator-installed CA. That is exactly what a TLS-inspecting network signs
  with, so the client leg keeps working while the relay leg dies with `unable to
get local issuer certificate`. Both legs must use the same set: `ensureCa`
  returns `outboundTrust` for that, and `additionalTrustedCAs` carries it.
- **`additionalTrustedCAs` is not additive on the Node side.** mockttp turns it
  into an explicit `ca` list (its bundled roots + ours), and `ca` _replaces_
  Node's default store. Passing only the corporate CA therefore _narrows_ the
  trust set — including dropping the OS store.
- **`run` sends its own log to a file, because the child owns the terminal.**
  A request line landing mid-redraw corrupts a full-screen TUI. `log/sink.ts`
  patches `process.stdout.write` / `process.stderr.write` rather than `console`:
  `console.*` and the default `process.emitWarning` handler both go through them,
  so that single choke point also catches **mockttp's own `console.error`**,
  which no discipline inside `Reporter` could have. The child is unaffected —
  `stdio: 'inherit'` gives it the file descriptors, not our JS streams.
  Note that **vitest replaces `console`**, so a `console.log` assertion under the
  suite proves nothing; `test/log.spec.ts` checks that path in a spawned process.
- **The banner stays on the terminal, the summary too.** Both are printed outside
  the capture window (before the child starts, after it exits), so neither can
  clobber anything — and they are what stops a redirected run from reading as
  "jean-claude did nothing". `Reporter` counts even under `--quiet`.
- **The log is appended to with a per-session header, never truncated.** Two
  concurrent `run`s (two Claude Code sessions) must not wipe each other.
- **`start` never redirects on its own and ignores `logFile:`.** Giving the log a
  terminal of its own is what `start` is for; a global `logFile:` silently muting
  it would be a trap. Only an explicit `--log` applies there.
- **Relay failures are reported from `on('rule-event')`.** A failed upstream
  fires neither `response` nor `abort`; mockttp answers 502 and logs a bare
  `Failed to handle request:` naming neither host nor reason. The
  `passthrough-abort` rule event is the only hook carrying both.
- **`NODE_USE_ENV_PROXY=1` is required**; without it Node ignores `HTTPS_PROXY`
  entirely. It only exists in Node ≥ 22.21 / ≥ 24.5, hence the startup warning.
- **When patching, always return an explicit decoded body** and strip
  `content-length` / `content-encoding` / `transfer-encoding`. Returning the
  original encoding headers alongside a decoded body corrupts the response.
- **Stub files are re-read on every request.** That is what makes editing a
  response take effect with no reload; do not add caching.
- **jean-claude never runs `sudo`.** `ca --install` prints commands for the user
  to run.
- **`env` is a separate command, not a flag on `start`.** The intuitive
  `eval "$(jean-claude start --export)"` cannot work — `start` is a foreground
  process, so the command substitution never returns. `start` writes
  `session.json` (port, bundle, pid) into the CA dir and `env` reads it, which is
  what makes the two-terminal workflow argument-free. `env` refuses a session
  whose pid is dead rather than printing a stale port.

## Conventions

- **TypeScript 5.9, not 7.x** — `typescript-eslint` pins its peer to `<6.1.0`.
  Revisit when that lifts.
- ESM (`"type": "module"`), imports carry the **`.ts` extension**
  (`allowImportingTsExtensions`); Node 24 resolves them natively and tsdown
  bundles them.
- **Run the source through `npm run jc` (tsx), not `node src/cli.ts`.** Node's
  type stripping is strip-only, and `Reporter` and `Recorder` both declare a
  constructor **parameter property** (`constructor(private readonly …)`), which
  it rejects outright: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Converting those two
  to plain field assignments would make bare `node` work, if that is ever worth
  more than the shorthand.
- Prettier: `printWidth: 120`, single quotes. Run `npm run format` before
  committing; `npm run lint` must be clean.
- `zod` schemas are the source of truth for the config; the README and `check`
  follow from `config/schema.ts`. Use `z.strictObject` so typos are reported by
  name, and `z.prettifyError` for user-facing messages.
- New config capability → schema + `actions.ts` + an integration test + README.

## Environment

Node 24.18 / npm 11 (nvm). `.npmrc` points at the **public npmjs registry**

Remote: `git@github.com:EtiennePasteur/jean-claude.git`, default branch `main`.
Published on npm as `@etiennepasteur/jean-claude`.

**The version lives in two places**: `package.json` and the hardcoded
`.version()` in `src/cli.ts`. Bump both, or `jean-claude --version` lies.

**The package is `@etiennepasteur/jean-claude`, not `jean-claude`.** The unscoped
name is taken by an unrelated tool that also targets Claude Code configuration
(`jean-claude` on npm, "Sync Claude Code configuration across machines using
Git"), and it ships the same `jean-claude` bin name. Being scoped is why
`publishConfig.access` has to be `public`: npm treats scoped packages as private
by default and `npm publish` fails with a 402 without it.

The installed command stays plain `jean-claude` — npm links a single `bin` entry
regardless of the scope, and `npx @etiennepasteur/jean-claude` resolves it too
(`libnpmexec/lib/get-bin-from-manifest.js` returns the only bin when there is
exactly one, before it ever compares names).

`bin` paths must not start with `./`. `npm publish` normalises the manifest and
drops a `./`-prefixed entry with `"bin[jean-claude]" script name … was invalid
and removed`, so the published metadata would advertise no binary at all.
