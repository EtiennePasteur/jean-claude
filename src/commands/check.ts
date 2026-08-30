import path from 'node:path';

import pc from 'picocolors';

import { loadConfig } from '../config/load.ts';
import { jeanClaudeHome } from '../config/paths.ts';
import { detectUpstream } from '../env/upstream.ts';

/** Describes what a rule does, in one word. */
function actionOf(rule: { respond?: unknown; patch?: unknown; request?: unknown }): string {
  if (rule.respond !== undefined) return pc.magenta('stub');
  if (rule.patch !== undefined && rule.request !== undefined) return pc.cyan('rewrite+patch');
  if (rule.patch !== undefined) return pc.cyan('patch');
  return pc.blue('rewrite');
}

/**
 * Validates the config and prints the rules as resolved, so the effective host
 * and method of each rule can be checked without starting the proxy.
 */
export async function checkCommand(configPath: string | undefined, homeOption?: string): Promise<number> {
  const home = homeOption !== undefined ? path.resolve(homeOption) : jeanClaudeHome();
  const loaded = await loadConfig(configPath, { home });
  const upstream = detectUpstream(loaded.config);

  const upstreamLabel =
    upstream !== undefined ? `${upstream.proxyUrl} ${pc.dim(`(from ${upstream.source})`)}` : pc.dim('direct');

  console.log(`  ${pc.dim('config    ')}${loaded.filePath}`);
  console.log(`  ${pc.dim('upstream  ')}${upstreamLabel}`);
  console.log(`  ${pc.dim('rules     ')}${loaded.rules.length}\n`);

  if (loaded.rules.length === 0) {
    console.log(`  ${pc.yellow('!')} no rules: every request will simply be logged and relayed.\n`);
    return 0;
  }

  for (const [index, { rule, label }] of loaded.rules.entries()) {
    const host = rule.host ?? loaded.config.host ?? pc.dim('any host');
    const method = rule.method?.join('|') ?? pc.dim('any');
    const target = rule.path ?? (rule.pathRegex !== undefined ? `re:${rule.pathRegex}` : pc.dim('any path'));

    console.log(`  ${pc.dim(String(index + 1).padStart(2))}  ${actionOf(rule)}  ${label}`);
    console.log(`      ${pc.dim('match')}  ${method} ${host}${target}`);
    if (rule.query !== undefined) console.log(`      ${pc.dim('query')}  ${JSON.stringify(rule.query)}`);
  }
  console.log('');

  return 0;
}
