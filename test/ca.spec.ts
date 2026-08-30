import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { generateCACertificate } from 'mockttp';
import { beforeAll, describe, expect, it } from 'vitest';

import { ensureCa, systemTrustInstructions } from '../src/ca/store.ts';

/**
 * What the certificate store has to guarantee: the child keeps every authority
 * it had before jean-claude got involved, and jean-claude itself keeps every
 * authority *it* had before mockttp replaced Node's trust store with an explicit
 * `ca` list. Narrowing either one breaks real traffic while everything still
 * looks plausible.
 */

const BEGIN = '-----BEGIN CERTIFICATE-----';

function countCerts(pem: string): number {
  return pem.split(BEGIN).length - 1;
}

let workDir: string;
let corporateCert: string;
let corporatePath: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'jean-claude-ca-'));

  const corporate = await generateCACertificate({ subject: { commonName: 'pretend corporate CA' } });
  corporateCert = corporate.cert;
  corporatePath = path.join(workDir, 'corporate.pem');
  await writeFile(corporatePath, corporateCert);
});

describe('ensureCa', () => {
  it('folds the machine trust store into the bundle', async () => {
    const ca = await ensureCa({ dir: path.join(workDir, 'plain') });
    const bundle = await readFile(ca.bundlePath, 'utf8');
    const ourCert = await readFile(ca.certPath, 'utf8');

    expect(ca.created).toBe(true);
    expect(bundle).toContain(ourCert.trim());
    // A real trust store, not just our own certificate.
    expect(countCerts(bundle)).toBeGreaterThan(1);
  });

  it('trusts the machine store on outbound connections, but not our own CA', async () => {
    const ca = await ensureCa({ dir: path.join(workDir, 'outbound') });
    const ourCert = await readFile(ca.certPath, 'utf8');

    expect(countCerts(ca.outboundTrust)).toBeGreaterThan(1);
    // Upstream we talk to real servers: our own signature has no business there.
    expect(ca.outboundTrust).not.toContain(ourCert.trim());
  });

  it('carries an inherited corporate CA into both the bundle and the outbound trust', async () => {
    const ca = await ensureCa({ dir: path.join(workDir, 'corp'), inheritedCa: corporatePath });

    expect(ca.inheritedCa).toBe(corporatePath);
    expect(await readFile(ca.bundlePath, 'utf8')).toContain(corporateCert.trim());
    // The relay leg is where a corporate CA actually matters: that is the
    // connection the intercepting appliance signs.
    expect(ca.outboundTrust).toContain(corporateCert.trim());
  });

  it('ignores an inherited path that does not exist', async () => {
    const ca = await ensureCa({ dir: path.join(workDir, 'missing'), inheritedCa: path.join(workDir, 'nope.pem') });

    expect(ca.inheritedCa).toBeUndefined();
    expect(countCerts(ca.outboundTrust)).toBeGreaterThan(0);
  });

  it('reuses an existing CA rather than minting a new one', async () => {
    const dir = path.join(workDir, 'reuse');
    const first = await ensureCa({ dir });
    const second = await ensureCa({ dir });

    expect(second.created).toBe(false);
    expect(await readFile(second.certPath, 'utf8')).toBe(await readFile(first.certPath, 'utf8'));
  });
});

describe('systemTrustInstructions', () => {
  it('covers every platform jean-claude runs on', () => {
    const lines = systemTrustInstructions('/tmp/ca.pem').join('\n');

    expect(lines).toContain('update-ca-certificates');
    expect(lines).toContain('update-ca-trust');
    expect(lines).toContain('Cert:\\LocalMachine\\Root');
  });
});
