import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pc from 'picocolors';

import { caDirIn, jeanClaudeHome, responsesDirIn } from '../config/paths.ts';
import { configPathIn } from '../config/load.ts';
import { CLAUDE_CODE_STUB, CLAUDE_CODE_TEMPLATE, CONFIG_TEMPLATE, STUB_TEMPLATE } from '../config/template.ts';
import { ensureCa } from '../ca/store.ts';
import { inheritedExtraCaCerts } from '../env/upstream.ts';

export interface InitOptions {
  home: string | undefined;
  /** Scaffold the Claude Code settings freeze instead of the generic example. */
  claudeCode: boolean;
}

/**
 * Sets up a jean-claude home: the config, its stub, and the CA. One command and
 * `jean-claude run -- <tool>` works from anywhere.
 *
 * Existing files are never overwritten - re-running `init` is safe, and is the
 * way to add the CA to a home scaffolded by an older version.
 */
export async function initCommand(options: InitOptions): Promise<number> {
  const home = options.home !== undefined ? path.resolve(options.home) : jeanClaudeHome();
  const stubName = options.claudeCode ? 'settings.GET.json' : 'todos.json';

  const files = [
    [configPathIn(home), options.claudeCode ? CLAUDE_CODE_TEMPLATE : CONFIG_TEMPLATE],
    [path.join(responsesDirIn(home), stubName), options.claudeCode ? CLAUDE_CODE_STUB : STUB_TEMPLATE],
  ] as const;

  const written: string[] = [];
  const skipped: string[] = [];

  for (const [target, contents] of files) {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      // `wx` fails if the file exists, which is exactly the guard we want.
      await writeFile(target, contents, { flag: 'wx' });
      written.push(target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      skipped.push(target);
    }
  }

  const ca = await ensureCa({ dir: caDirIn(home), inheritedCa: inheritedExtraCaCerts() });
  (ca.created ? written : skipped).push(ca.certPath);
  written.push(ca.bundlePath); // rewritten on every call, so always "created"

  for (const file of written) console.log(`  ${pc.green('created')}  ${file}`);
  for (const file of skipped) console.log(`  ${pc.yellow('kept')}     ${file} ${pc.dim('(already existed)')}`);

  const next = options.claudeCode ? 'jean-claude run -- claude' : 'jean-claude run -- <your command>';
  console.log(`\n  ${pc.dim(`Next: \`${next}\``)}`);
  console.log(`  ${pc.dim('`jean-claude ca --install` if a target cannot be pointed at the bundle.')}\n`);

  return 0;
}
