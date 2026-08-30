/** Scaffolding written by `jean-claude init`. */

/**
 * The commented-out tour of the config format, shared by both templates so the
 * Claude Code one does not become a dead end when you want a second rule.
 */
const EXAMPLES = `  # 2 - Patch the real response. It does reach the server; we edit what comes back.
  #     'merge' is for object responses, 'jsonPatch' for arrays and precise edits.
  # - path: /api/users/:id
  #   patch:
  #     merge: { verified: true }

  # 3 - Force a status, headers or latency, to exercise error handling.
  # - path: /api/flaky
  #   patch:
  #     status: 500
  #     body: { error: "boom" }
  #     delay: 2000

  # 4 - Rewrite the outgoing request before it reaches the server.
  # - host: auth.example.com
  #   path: /oauth/token
  #   request:
  #     host: staging-auth.example.com
  #     headers: { authorization: "Bearer TEST" }

  # Captured path parameters are interpolable into the stub file name:
  # - path: /api/users/:id
  #   respond: ./responses/users/{id}.json
`;

export const CONFIG_TEMPLATE = `# jean-claude - HTTPS traffic rewriting rules.
#
# Every rule is tried in file order; the first one that matches wins.
# Anything that matches nothing is still decrypted, logged and relayed untouched.

# Default host for the rules below. Remove it to match any host.
host: api.example.com

# Upstream proxy for relayed traffic:
#   auto  inherit HTTPS_PROXY from the environment (default)
#   off   always connect directly
#   <url> an explicit proxy
upstream: auto

# Where jean-claude's own log goes while \`run\` has a child, so a full-screen
# tool keeps the terminal to itself. A path relative to this file, or 'terminal'
# to leave the log interleaved with your tool's output.
# Default: <home>/jean-claude.log
# logFile: jean-claude.log

rules:
  # 1 - Replace the response with a file. The server is never contacted.
  - name: frozen todos
    method: GET
    path: /api/todos
    respond: ./responses/todos.json

${EXAMPLES}`;

export const STUB_TEMPLATE = `${JSON.stringify([{ title: 'Dining', details: 'bla-bla-bla' }], null, 2)}\n`;

/**
 * `init --claude-code`: pin Claude Code's managed settings to a local file, so
 * the ones pushed by the account no longer apply.
 */
export const CLAUDE_CODE_TEMPLATE = `# jean-claude - HTTPS traffic rewriting rules.
#
# Every rule is tried in file order; the first one that matches wins.
# Anything that matches nothing is still decrypted, logged and relayed untouched.

# Default host for the rules below. Remove it to match any host.
host: api.anthropic.com

# Upstream proxy for relayed traffic:
#   auto  inherit HTTPS_PROXY from the environment (default)
#   off   always connect directly
#   <url> an explicit proxy
upstream: auto

# Where jean-claude's own log goes while \`run\` has a child, so a full-screen
# tool keeps the terminal to itself. A path relative to this file, or 'terminal'
# to leave the log interleaved with your tool's output.
# Default: <home>/jean-claude.log
# logFile: jean-claude.log

rules:
  # 1 - Freeze the settings Claude Code fetches at startup: it gets this file
  #     instead, and the server is never contacted for it. Edit the 'settings'
  #     object in the stub; it is re-read on every request.
  #
  #     To start from what your account actually sends:
  #
  #       jean-claude run --record ./captures -- claude
  #       cp ./captures/api.anthropic.com/api/claude_code/settings.GET.json \\
  #          ./responses/settings.GET.json
  - name: frozen claude_code settings
    method: GET
    path: /api/claude_code/settings
    respond: ./responses/settings.GET.json

${EXAMPLES}`;

export const CLAUDE_CODE_STUB = `${JSON.stringify(
  {
    uuid: '1cb619ae-b7bd-495b-9f0d-741d32e4fad6',
    checksum: 'sha256:3081f0d1458367573f9a7cef56e490081218986bc8e20bc59257dfc10d930826',
    settings: {
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      permissions: { defaultMode: 'plan' },
    },
  },
  null,
  2,
)}\n`;
