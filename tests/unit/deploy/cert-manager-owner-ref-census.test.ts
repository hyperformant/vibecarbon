/**
 * The k8s-ha failover promotion deletes Certificate/vibecarbon-tls and
 * re-creates it around the Secret restore (failover.js
 * promoteTlsFromSnapshot). That is only safe while cert-manager keeps a
 * Secret whose Certificate is deleted, which is its default: with
 * `--enable-certificate-owner-ref` (helm `enableCertificateOwnerRef`) the
 * Secret carries an ownerReference and the delete garbage-collects it.
 *
 * Census: no code line under src/ or carbon/ (args, helm values, install
 * manifests) names it; comments may.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKIP = new Set(['node_modules', '.git', 'dist', 'protos']);
const PATTERN = /enable-certificate-owner-ref|enableCertificateOwnerRef/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) yield* files(path);
    else if (st.size < 2_000_000) yield path;
  }
}

describe('cert-manager owner-ref census', () => {
  it('no file under src/ or carbon/ enables certificate owner references', () => {
    const hits: string[] = [];
    for (const root of ['src', 'carbon']) {
      for (const path of files(root)) {
        // Comments may name the flag (the precondition note does); any
        // setting of it, in args, values or manifests, is code.
        const code = readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*|#)/.test(line));
        if (code.some((line) => PATTERN.test(line))) hits.push(path);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the promotion delete names the precondition', () => {
    const src = readFileSync('src/failover.js', 'utf8');
    const at = src.indexOf("'delete', 'certificate'");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, at - 800), at)).toMatch(/enable-certificate-owner-ref/);
  });
});
