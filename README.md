# jean-claude

A CLI **MITM HTTPS proxy** for Node. Point any tool at it and you can see,
capture and rewrite its API traffic — driven by a YAML file, with no change to
the tool and no change to the server. The tool being intercepted never knows.

```
your tool  ──►  jean-claude  ──►  api.example.com
                ▲
                └── ~/.config/jean-claude/jean-claude.yaml
                    + responses/todos.json
```

Reproduce a 500. Test a business case that is absent from the dataset. Freeze a
flaky endpoint. Redirect a call to staging. Or simply find out what a tool
actually talks to.

## Quick start

```bash
npm install -g @etiennepasteur/jean-claude   # or: npx @etiennepasteur/jean-claude
jean-claude init                             # config + CA + a sample stub
jean-claude run -- npx your-tool
```

`init` writes `~/.config/jean-claude/` with a CA and this config:

```yaml
host: api.example.com

rules:
  - name: frozen todos
    method: GET
    path: /api/todos
    respond: ./responses/todos.json
```

Every request is decrypted and logged; anything matching no rule is relayed
untouched.

```
  GET   api.example.com/api/todos      200  → stub ./responses/todos.json
  POST  api.example.com/api/login      401
```

Installing globally is the better default for something you launch often: the
dependency tree is ~55 MB, so the first `npx` run is a real download. `npx` is
the right call for trying it once, or for a throwaway CI step.

## What a rule can do

### 1. Replace the response with a file

The request never leaves the machine.

```yaml
rules:
  - path: /api/todos
    method: GET
    respond: ./responses/todos.json
```

The stub is re-read on **every request**, so editing it takes effect
immediately — no restart, no reload.

Longer form, with status, headers and latency — or an inline body, with no file
at all:

```yaml
rules:
  - path: /api/todos
    respond:
      file: ./responses/todos.json
      status: 201
      headers: { x-jean-claude: stub }
      delay: 500

  - path: /api/health
    respond:
      body: { status: 'ok' }
```

### 2. Patch the real response

The request _does_ reach the server; jean-claude edits what comes back. Useful
when you want the live payload with one field bent, rather than a frozen copy
that goes stale.

```yaml
rules:
  # Precise edit, and the only option that works on an array response.
  - path: /api/todos
    patch:
      jsonPatch: [{ op: replace, path: /0/title, value: Dining }]

  # Deep merge, for object responses.
  - path: /api/users/:id
    patch:
      merge: { verified: true }

  # A failing, slow server. The original body is preserved unless you replace it.
  - path: /api/flaky
    patch:
      status: 500
      body: { error: 'boom' }
      delay: 2000
```

`patch` accepts `status`, `headers` (merged), `replaceHeaders` (wholesale),
`merge`, `jsonPatch`, `body`, `file` and `delay`.

### 3. Rewrite the outgoing request

```yaml
rules:
  - host: auth.example.com
    path: /oauth/token
    request:
      host: staging-auth.example.com
      path: /v2/token
      headers: { authorization: 'Bearer TEST' }
      removeHeaders: [cookie]
```

`request` combines with `patch` — you can redirect a call _and_ doctor its
response. It cannot combine with `respond`, which short circuits the request
before it goes anywhere.

## Matching

```yaml
host: api.example.com # default host for every rule below
port: 8888 # optional, otherwise a free port is picked

rules:
  - host: auth.example.com # overrides the default
    method: [POST, PUT] # one method or a list, case-insensitive
    path: /api/users/:id # exact, :param, or a bare * wildcard
    query: { page: '2' } # required params; extra ones are ignored
```

- A rule with no `host` matches **any** host; `*.example.com` matches any subdomain.
- `path` is compiled by `path-to-regexp`. Use `pathRegex` for a raw regular expression.
- Captured parameters interpolate into the stub path: `respond: ./responses/users/{id}.json`.
- Rules are tried in file order and **the first match wins**. `jean-claude check`
  prints them as resolved.

## Recording real traffic

```bash
jean-claude run --record ./captures -- npx your-tool
```

```
  GET   api.example.com/api/users/42   200  ⇒ captures/api.example.com/api/users/42.GET.json
```

Captures contain the **body only**, re-indented, so a captured file drops
straight into a `respond:` rule. When a rule patches a response, the capture is
still the untouched server response, not what the client saw.

By default only affected traffic is logged. Add `-v` to see everything, `-q` to
see nothing.

## Commands

```
jean-claude run -- <command>   run a command with its HTTPS traffic intercepted
jean-claude start              run the proxy alone, in its own terminal
jean-claude env                print the environment for an already running `start`
jean-claude check              validate the config and print the rules as resolved
jean-claude ca                 show the certificate store, and how to trust it
jean-claude init               set up the jean-claude directory: config, stub, CA
```

Shared flags: `-c/--config`, `-p/--port`, `-r/--record`, `--home`,
`--log <path|terminal>`, `-v/--verbose`, `-q/--quiet`, `--no-watch`.

`run` exits with the child's exit code, so it drops into a CI pipeline
unchanged. The config is watched and reloaded on save; a config that fails to
parse is reported and the previous rules stay in effect. Changing
`tlsPassthrough` is the one setting that needs a restart.

### Two terminals: `start` + `env`

For a GUI app, a service that is already running, or simply to keep
jean-claude's log out of your tool's output:

```bash
# terminal 1 - the proxy and its log live here
jean-claude start -v

# terminal 2 - your tool
eval "$(jean-claude env)"
your-tool
```

`start` records the live session (port, bundle path, pid) in
`session.json`, and `env` reads it — so the second shell needs no arguments.
`env` refuses a stale session rather than handing out a dead port. Use
`env -p 8899` to target a session started elsewhere, `--json` for
machine-readable output.

`eval "$(jean-claude start --export)"` **cannot** work: `start` runs in the
foreground, so the command substitution would never return. That is why `env`
exists.

## Where everything lives

```
~/.config/jean-claude/          # $XDG_CONFIG_HOME/jean-claude if set
├── jean-claude.yaml
├── jean-claude.log             # where `run` sends its log, see below
├── responses/
├── ca/  ca.pem  ca.key  bundle.pem
└── session.json                # only while `start` is running
```

The config is resolved in this order: `--config <path>`, then `jean-claude.yaml`
(or `.yml`) in the current directory and walking up, then
`~/.config/jean-claude/jean-claude.yaml`. So a global rule applies everywhere,
and a repo that drops its own `jean-claude.yaml` at the root overrides it for
that project. Paths inside a config (`respond:`, `patch: { file: }`) are always
relative to that config file.

`--home <dir>` relocates the whole directory — for a throwaway setup, or to run
two proxies side by side.

## Where jean-claude's own log goes

`run` gives the terminal to the tool it spawns. A request line landing in the
middle of a full-screen TUI corrupts the display, so by default the log goes to
a file instead, announced in the banner:

```
$ jean-claude run -- your-tool

  proxy     http://127.0.0.1:8000
  ca        ~/.config/jean-claude/ca/ca.pem
  bundle    ~/.config/jean-claude/ca/bundle.pem
  config    ~/.config/jean-claude/jean-claude.yaml  1 rule(s)
  upstream  direct
  log       ~/.config/jean-claude/jean-claude.log  (tail -f to follow)
  command   your-tool

  … the tool owns the screen from here …

  12 requests, 1 rule hit, 2 upstream errors  →  ~/.config/jean-claude/jean-claude.log
```

Banner and summary are printed outside that window — before the child starts and
after it exits — so neither can clobber anything, and the summary is what tells
you a redirected run did something.

Destination, first match wins:

| Setting                   | Effect                                        |
| ------------------------- | --------------------------------------------- |
| `--log <path>`            | that file (relative to the current directory) |
| `--log terminal`          | on screen, interleaved                        |
| `logFile:` in the config  | that file (relative to the config file)       |
| stdout is a terminal      | `<home>/jean-claude.log`                      |
| anything else (pipes, CI) | on screen, unchanged                          |

The file is appended to with a per-session header, never truncated, so two
concurrent runs cannot wipe each other. `start` never redirects on its own and
ignores `logFile:` — giving the log a terminal of its own is what it is for.

## Certificates

On first run, jean-claude generates a CA in `~/.config/jean-claude/ca/`:

| File                | Role                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| `ca.pem` / `ca.key` | the authority that signs per-host certificates on the fly (`ca.key` is `0600`) |
| `bundle.pem`        | `ca.pem` + the system trust store + any inherited corporate CA                 |

The bundle exists because `SSL_CERT_FILE` and `CURL_CA_BUNDLE` **replace** the
trust store rather than adding to it — handing a target only our own CA would
cut it off from every other authority. The system store is read through
`tls.getCACertificates('system')`, so a machine-wide CA is picked up on
**Windows and macOS** too, where the store is an OS API and not a file.

`run` points the child at the bundle, so **no root access and no system-wide
trust change is needed**. If you do want the CA installed system-wide (for a GUI
app, say), `jean-claude ca --install` prints the commands for you to run
yourself. jean-claude never invokes `sudo` on its own.

## How the target is pointed at the proxy

`jean-claude run` injects these into the child environment:

| Variable                                                                                   | Why                                                 |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `HTTP_PROXY`, `HTTPS_PROXY` (+ lowercase)                                                  | the universal convention                            |
| `NODE_USE_ENV_PROXY=1`                                                                     | **required**: Node ignores `HTTPS_PROXY` without it |
| `NODE_EXTRA_CA_CERTS`                                                                      | Node targets                                        |
| `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`, `GIT_SSL_CAINFO` | OpenSSL, curl, python/requests, AWS CLI, git        |

`NO_PROXY` is **unset**, not narrowed. The tempting default is
`localhost,127.0.0.1,::1`, but that makes every localhost target bypass
jean-claude silently — and intercepting a local dev API is one of the main
reasons to reach for this tool. A bypass that still produces plausible traffic is
the worst possible failure mode, so exclusions are opt-in, and printed in the
startup banner:

```yaml
noProxy:
  - metrics.internal
```

`NODE_USE_ENV_PROXY` only exists in Node **≥ 22.21** or **≥ 24.5**. Below that a
Node-based target silently ignores the proxy; jean-claude warns you at startup.

Known gaps worth knowing rather than fighting: Java uses its own keystore
(`keytool`), Rust tools built on `rustls` embed their roots and ignore every
environment variable, and anything with pinned certificates needs
`tlsPassthrough`.

## Troubleshooting

**A 502 the target never asked for.** Interception can be perfect and the relay
leg still fail:

```
  GET   api.example.com/v1/things   upstream  UNABLE_TO_GET_ISSUER_CERT_LOCALLY
```

The authority signing the traffic — usually your network's TLS inspection
appliance — is in neither the machine trust store nor `NODE_EXTRA_CA_CERTS`.
Export it and point `NODE_EXTRA_CA_CERTS` at it before starting jean-claude.

**Behind a corporate proxy.** jean-claude reads the environment before rewriting
it for the child and chains onto what it finds: `HTTPS_PROXY` / `HTTP_PROXY` /
`NO_PROXY` for the relayed traffic (override with `upstream: auto | off | <url>`),
and `NODE_EXTRA_CA_CERTS` folded into `bundle.pem`.

**A target that pins its certificates** will fail the handshake. jean-claude says
so explicitly; tunnel that host without interception:

```yaml
tlsPassthrough:
  - pinned.example.com
```

## Recipe: freezing Claude Code's settings

A worked example of `respond:` against a real API. Claude Code calls
`GET https://api.anthropic.com/api/claude_code/settings` at startup and applies
the managed settings attached to your account; answering that one request from a
local file stops them moving under you between sessions. Everything else — the
actual conversation — is relayed untouched.

```bash
jean-claude init --claude-code
jean-claude run -- claude
```

That scaffolds the rule and a stub; edit the `settings` object in
`~/.config/jean-claude/responses/settings.GET.json` and it applies at the next
startup. To start from what your account really sends, record it once:

```bash
jean-claude run --record ./captures -- claude
cp ./captures/api.anthropic.com/api/claude_code/settings.GET.json \
   ~/.config/jean-claude/responses/settings.GET.json
```

## Development

```bash
npm install
npm test           # 155 tests, including an end-to-end MITM suite
npm run typecheck
npm run lint
npm run build
npm run jc -- --help    # run from source
```

The end-to-end suite runs a plain `node:https` server as the fake upstream,
holding a leaf certificate minted by jean-claude's own CA, so it needs no network
access. It asserts the things that actually matter: that a `respond` rule never
reaches the server, that `patch` does, and that a status-only patch leaves the
body intact.

One gotcha if you extend it: pointing jean-claude at a _second mockttp instance_
stalls ~15s on the first upstream connection. That is an artefact of mockttp
talking to mockttp, not of jean-claude — against a real HTTPS server the relay
costs ~25ms. Hence the plain `node:https` upstream.

Built on [mockttp](https://github.com/httptoolkit/mockttp), which does the heavy
lifting: CONNECT tunnelling, per-host certificate minting, HTTP/2 and WebSockets.

## Licence

MIT — see [LICENSE](LICENSE).
