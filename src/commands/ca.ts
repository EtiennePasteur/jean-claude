import { readFile } from 'node:fs/promises';
import path from 'node:path';

import pc from 'picocolors';

import { ensureCa, systemTrustInstructions } from '../ca/store.ts';
import { caDirIn, jeanClaudeHome } from '../config/paths.ts';
import { inheritedExtraCaCerts } from '../env/upstream.ts';

export interface CaOptions {
  home: string | undefined;
  /** Write the CA certificate to stdout, for piping. */
  print: boolean;
  /** Show the commands to install the CA into the system trust store. */
  install: boolean;
}

/**
 * Inspects the certificate store. Never installs anything itself: trust changes
 * need root, and are the user's call to make explicitly.
 */
export async function caCommand(options: CaOptions): Promise<number> {
  const home = options.home !== undefined ? path.resolve(options.home) : jeanClaudeHome();
  const ca = await ensureCa({ dir: caDirIn(home), inheritedCa: inheritedExtraCaCerts() });

  if (options.print) {
    process.stdout.write(await readFile(ca.certPath, 'utf8'));
    return 0;
  }

  console.log(`  ${pc.dim('cert    ')}${ca.certPath}${ca.created ? pc.dim('  (just generated)') : ''}`);
  console.log(`  ${pc.dim('key     ')}${ca.keyPath}`);
  console.log(`  ${pc.dim('bundle  ')}${ca.bundlePath}`);
  console.log(`  ${pc.dim('system  ')}${ca.systemTrust}`);
  if (ca.inheritedCa !== undefined) {
    console.log(`  ${pc.dim('corp    ')}${ca.inheritedCa}  ${pc.dim('(inherited from NODE_EXTRA_CA_CERTS)')}`);
  }

  if (options.install) {
    console.log(`\n  ${pc.bold('Installing into the system trust store')} ${pc.dim('(run these yourself)')}\n`);
    for (const line of systemTrustInstructions(ca.certPath)) console.log(`    ${line}`);
    console.log('');
  } else {
    console.log(
      `\n  ${pc.dim('`jean-claude run` injects this automatically. Use `--install` for the system trust store.')}\n`,
    );
  }

  return 0;
}
