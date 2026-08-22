/**
 * Extract the most classifiable one-line detail from a failed deploy's
 * stdio, shared by the deploy and restore steps.
 *
 * Preference order:
 *   1. last structured `FAIL: …` line (the deploy's own self-diagnosis,
 *      PR 1BY/1CA)
 *   2. last `Error: …` line (cli.js's central handler prints the thrown
 *      message in this form) — joined with the last `(failed)` perf marker
 *      for stage context
 *   3. last `[perf] … (failed)` marker line alone
 *   4. raw stdout, then stderr
 *
 * The `Error:` tier exists because of the 2026-07-08 k8s restore failure:
 * the perf marker ("[perf] deploy.k3s.full 868122ms (failed)") outranked the
 * Error line carrying the actual signal ("k3s binary did not appear … ssh
 * Connection timed out"), so classify-failure saw no infra pattern and
 * tagged a retryable infra failure as [unknown].
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function lastMatchingLine(s: string, test: (line: string) => boolean): string | null {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(test);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

const isFailLine = (l: string) => /^FAIL:\s/.test(l);
const isErrorLine = (l: string) => /^Error:\s/.test(l);
const isPerfFailedLine = (l: string) => /\(failed\)\s*$/.test(l);
// cli.js's central handler prints this when a step child dies without a
// thrown message — it carries no classifiable signal on its own.
const isBareStepWrapper = (l: string) => /^Error: \[step:[a-z-]+\] code: -?\d+$/.test(l);
// Pulumi/provider diagnostics are lowercase `error:` lines; `update failed`
// is Pulumi's generic footer, never the signal.
const isPulumiDiagnosticLine = (l: string) =>
  /(^|\s)error:\s\S/.test(l) && !/^Error:/.test(l) && !/error: update failed/.test(l);

export function extractDeployFailureDetail(stdout?: string, stderr?: string): string {
  const out = (stdout || '').replace(ANSI_RE, '').trim();
  const err = (stderr || '').replace(ANSI_RE, '').trim();

  const failLine = lastMatchingLine(out, isFailLine) || lastMatchingLine(err, isFailLine);
  if (failLine) return failLine;

  const perfLine =
    lastMatchingLine(out, isPerfFailedLine) || lastMatchingLine(err, isPerfFailedLine);
  let errorLine = lastMatchingLine(out, isErrorLine) || lastMatchingLine(err, isErrorLine);
  // A bare step wrapper (`Error: [step:x] code: -2`) outranking the real
  // diagnostic is how round-B d3's classified infra shape read [unknown]
  // for two rounds: the Pulumi diagnostic is a LOWERCASE `error:` line the
  // Error: tier never sees. Dig one level deeper and lead with it.
  if (errorLine && isBareStepWrapper(errorLine)) {
    const diagnostic =
      lastMatchingLine(out, isPulumiDiagnosticLine) ||
      lastMatchingLine(err, isPulumiDiagnosticLine);
    if (diagnostic) errorLine = `${diagnostic} | ${errorLine}`;
  }
  if (errorLine) return perfLine ? `${errorLine} | ${perfLine}` : errorLine;
  if (perfLine) return perfLine;

  return out || err;
}
