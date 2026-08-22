import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The registry-login skip gates fingerprinted their token with
// `token.slice(0, 8)`. For the formats we actually see that is a CONSTANT:
// every Docker Hub PAT starts `dckr_pat_`, so the fingerprint was the literal
// string `dckr_pat` for every token ever issued, and GitHub fine-grained PATs
// reduce to `github_p` the same way.
//
// Consequences, both silent:
//   - Rotating a leaked credential produced an IDENTICAL gate input, so the
//     login step skipped. The server kept the REVOKED token in
//     ~/.docker/config.json and `docker compose pull` degraded to anonymous
//     pulls, hitting exactly the per-IP rate limit the login exists to avoid.
//   - The prefix is plaintext token material written into
//     .vibecarbon/deploy-state-*.json — which the GHCR call site's own comment
//     said it was trying to avoid ("hash the token's fingerprint, not the
//     token itself").
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const effectsSrc = readFileSync(join(repoRoot, 'src/lib/deploy/effects/index.js'), 'utf-8');

// Re-implements the shipped fingerprint so the PROPERTY (not the source text)
// is what gets asserted below.
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

describe('registry-login gate fingerprints tokens with a digest, not a prefix', () => {
  it('no login gate slices a raw token', () => {
    const code = effectsSrc
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(
      code,
      'token.slice(0, N) is a constant for dckr_pat_* / github_pat_* tokens, so a ' +
        'rotated credential never busts the gate — and it writes plaintext token ' +
        'material into the deploy-state file.',
    ).not.toMatch(/token\.slice\(0,\s*\d+\)/);
  });

  it('both gates route through tokenFingerprint', () => {
    expect(effectsSrc).toMatch(/tokenFp:\s*tokenFingerprint\(dockerHubCreds\.token\)/);
    expect(effectsSrc).toMatch(/tokenFp:\s*tokenFingerprint\(ciReady\.ghcrPullCreds\.token\)/);
  });

  it('two Docker Hub PATs sharing the 8-char prefix produce DIFFERENT fingerprints', () => {
    // The exact case the old gate could not distinguish: revoke and reissue.
    const before = 'dckr_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const after = 'dckr_pat_BBBBBBBBBBBBBBBBBBBBBBBBBBB';
    expect(before.slice(0, 8)).toBe(after.slice(0, 8)); // the old bug, pinned
    expect(sha(before)).not.toBe(sha(after));
  });

  it('the fingerprint leaks no token substring', () => {
    const token = 'dckr_pat_SUPERSECRETVALUE';
    const fp = sha(token);
    expect(token).not.toContain(fp);
    expect(fp).not.toContain('SUPERSECRET');
  });
});
