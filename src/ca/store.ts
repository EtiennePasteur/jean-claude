import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';

import { generateCACertificate } from 'mockttp';

/**
 * Layout of jean-claude's certificate store.
 *
 * `ca.pem` / `ca.key`: the authority that signs per-host certificates on the fly.
 * `bundle.pem`       : ca.pem + the system trust store + any inherited corporate CA.
 *
 * The bundle matters because `SSL_CERT_FILE` and `CURL_CA_BUNDLE` *replace* the
 * trust store rather than adding to it: shipping only our own CA would cut the
 * target tool off from every other authority.
 */
export interface CaPaths {
  dir: string;
  certPath: string;
  keyPath: string;
  bundlePath: string;
}

/**
 * Candidate system trust stores, by distribution family. Only a fallback: see
 * `readSystemTrust` for why the OS API comes first.
 */
const SYSTEM_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu, Alpine
  '/etc/pki/tls/certs/ca-bundle.crt', // RHEL, Fedora, Rocky
  '/etc/ssl/ca-bundle.pem', // openSUSE
  '/etc/ssl/cert.pem', // Alpine, macOS via Homebrew
];

export function caPathsIn(dir: string): CaPaths {
  return {
    dir,
    certPath: path.join(dir, 'ca.pem'),
    keyPath: path.join(dir, 'ca.key'),
    bundlePath: path.join(dir, 'bundle.pem'),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findSystemBundle(): Promise<string | undefined> {
  for (const candidate of SYSTEM_CA_BUNDLES) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

interface SystemTrust {
  /** The certificates, as PEM text. */
  certs: string;
  /** Where they came from, for `jean-claude ca`. */
  source: string;
}

/**
 * The machine's own trust store.
 *
 * `tls.getCACertificates('system')` is tried first because on Windows and macOS
 * the store is an OS API, not a file: the Unix paths above find nothing there,
 * and falling back to Node's bundled Mozilla roots silently drops every CA the
 * machine was given by its administrators. That is exactly the CA an
 * intercepting corporate proxy signs with, so losing it makes the relay leg fail
 * with `unable to get local issuer certificate` while the client side keeps
 * working - a failure that looks like a jean-claude bug and is not.
 *
 * The API landed in Node 22.15 / 24.0, hence the feature detection.
 */
async function readSystemTrust(): Promise<SystemTrust> {
  if (typeof tls.getCACertificates === 'function') {
    try {
      const certs = tls.getCACertificates('system');
      if (certs.length > 0) return { certs: certs.join('\n'), source: `the OS trust store (${certs.length} certs)` };
    } catch {
      // Node knows the function but not the 'system' type: fall through.
    }
  }

  const bundlePath = await findSystemBundle();
  if (bundlePath !== undefined) return { certs: await readFile(bundlePath, 'utf8'), source: bundlePath };

  return { certs: tls.rootCertificates.join('\n'), source: "Node's built-in roots" };
}

export interface EnsureCaResult extends CaPaths {
  /** `true` if the CA was just generated, `false` if it was already on disk. */
  created: boolean;
  /** Where the system certificates folded into the bundle came from. */
  systemTrust: string;
  /** Corporate CA inherited through `NODE_EXTRA_CA_CERTS`, if there was one. */
  inheritedCa: string | undefined;
  /**
   * What jean-claude itself has to trust when relaying, as PEM text: the system
   * store plus the inherited corporate CA.
   *
   * The same certificates as `bundle.pem` minus our own CA - upstream we talk to
   * real servers, so there is no reason to accept our own signature there.
   */
  outboundTrust: string;
}

export interface EnsureCaOptions {
  dir: string;
  inheritedCa?: string;
}

/**
 * Make sure the CA exists, and (re)generate the trust bundle.
 *
 * The bundle is rewritten on every call: the system store or the corporate CA
 * may well have changed since the last run.
 */
export async function ensureCa({ dir, inheritedCa }: EnsureCaOptions): Promise<EnsureCaResult> {
  const paths = caPathsIn(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const created = !((await exists(paths.certPath)) && (await exists(paths.keyPath)));

  if (created) {
    const { key, cert } = await generateCACertificate({
      subject: {
        commonName: 'jean-claude MITM CA - DO NOT TRUST ELSEWHERE',
        organizationName: 'jean-claude',
      },
    });
    await writeFile(paths.certPath, cert, { mode: 0o644 });
    await writeFile(paths.keyPath, key, { mode: 0o600 });
  }

  const ourCert = await readFile(paths.certPath, 'utf8');
  const system = await readSystemTrust();

  const inheritedCerts = inheritedCa && (await exists(inheritedCa)) ? await readFile(inheritedCa, 'utf8') : '';
  const resolvedInherited = inheritedCerts === '' ? undefined : inheritedCa;

  const inheritedSection = resolvedInherited
    ? [`# CA inherited from NODE_EXTRA_CA_CERTS (${resolvedInherited})`, inheritedCerts.trim()]
    : [];
  const systemSection = [`# System trust store (${system.source})`, system.certs.trim()];

  const bundle = [
    '# Generated by jean-claude - do not edit by hand.',
    '# jean-claude CA',
    ourCert.trim(),
    ...inheritedSection,
    ...systemSection,
    '',
  ].join('\n');

  await writeFile(paths.bundlePath, bundle, { mode: 0o644 });

  return {
    ...paths,
    created,
    systemTrust: system.source,
    inheritedCa: resolvedInherited,
    outboundTrust: [...inheritedSection, ...systemSection, ''].join('\n'),
  };
}

/**
 * Commands to install the CA into the system trust store, per platform.
 * Returned as text on purpose: jean-claude never runs `sudo` on its own.
 */
export function systemTrustInstructions(certPath: string): string[] {
  return [
    '# Debian / Ubuntu (the .crt extension is mandatory)',
    `sudo cp ${certPath} /usr/local/share/ca-certificates/jean-claude.crt`,
    'sudo update-ca-certificates',
    '',
    '# RHEL / Fedora / Rocky',
    `sudo cp ${certPath} /etc/pki/ca-trust/source/anchors/jean-claude.crt`,
    'sudo update-ca-trust extract',
    '',
    '# Windows, current user only (PowerShell, no elevation needed)',
    `certutil -user -addstore Root "${certPath}"`,
    '',
    '# Windows, machine-wide (PowerShell as administrator)',
    `Import-Certificate -FilePath "${certPath}" -CertStoreLocation Cert:\\LocalMachine\\Root`,
    '',
    '# To uninstall: delete the copied file and re-run the matching update command,',
    '# or on Windows remove the entry from the Root store (certmgr.msc).',
  ];
}
