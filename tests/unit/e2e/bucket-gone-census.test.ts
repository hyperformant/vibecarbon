/**
 * Repo-wide tripwire for the "bucket already gone" failure class.
 *
 * A post-scenario sweep lists a bucket that final-destroy removed seconds
 * earlier (object-storage listings lag deletes), its delete answers "no such
 * bucket", and the sweep must read that as clean, not as a destroy
 * regression. The first fix (run 33538738831) matched the error's WORDS.
 * Run 43757126064 (DO k8s, 2026-11-15) then answered with the same code and
 * an empty message, which AWS SDK v3 words "UnknownError": the words matched
 * nothing and a clean run read [regression]. The code was on err.name and
 * the 404 on err.$metadata the whole time.
 *
 * The opposite mistake is worse. A "no such bucket" is one endpoint's answer
 * (DO's nyc3 says it for a bucket that lives in sfo3, probed 2026-11-15), so
 * reading it as gone without asking every region can hide a real leak.
 *
 * So the rule, enforced here for every call site:
 *  (a) a catch around `.emptyAndDeleteBucket(` in src/, scripts/ or
 *      tests/e2e/ decides "already gone" through classifyBucketDeleteError
 *      (tests/e2e/utils/bucket-already-gone.ts), which reads the code and
 *      the HTTP status, not just the words, and counts the bucket gone only
 *      when locateBucket finds it in no region; or it is listed below with
 *      a reason;
 *  (b) no source line decides a bucket is missing by matching an error's
 *      TEXT against a missing-bucket spelling, except the listed sites whose
 *      input is text by nature (another program's output).
 *
 * Same inventory idiom as list-endpoint-pagination-sweep.test.ts: a new
 * exception is added HERE with a reason, and the exact-match assertions
 * prune a row whose site has gone.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SWEEP_ROOTS = ['src', 'scripts', join('tests', 'e2e')];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'results']);
const EXTENSIONS = ['.js', '.ts', '.mjs'];

/** Call sites of `.emptyAndDeleteBucket(` that do not need the shared classifier. */
const CALL_SITE_EXCEPTIONS: Array<{ file: string; call: string; reason: string }> = [
  {
    file: 'src/destroy.js',
    call: 'return store.emptyAndDeleteBucket(bucketName);',
    reason:
      "The backups purge's op inside atBucketRegion, whose isNoSuchBucket reads name, Code and " +
      'HTTP 404, then asks locateBucket before it says gone.',
  },
  {
    file: 'src/destroy.js',
    call: '(store) => store.emptyAndDeleteBucket(s3BucketName),',
    reason: 'The app-bucket purge, the same atBucketRegion route as the backups purge.',
  },
  {
    file: 'src/destroy.js',
    call: 'const result = await s3Provider.emptyAndDeleteBucket(stateBucket);',
    reason:
      'The state-bucket purge decides nothing about a missing bucket: every error, that one ' +
      'included, is recorded as a leak, so it fails loud and can never read clean.',
  },
  {
    file: 'scripts/sweep-buckets.js',
    call: 'const result = await s3.emptyAndDeleteBucket(bucket.name);',
    reason:
      'The age-based reaper reads err.name (isWrongEndpointError), never the words, and only ' +
      'skips the bucket for this region; it claims nothing clean, and it walks every region, ' +
      "so the bucket's own region deletes a real one.",
  },
];

/** Regex literals that name a missing-bucket spelling, sanctioned because their input is text. */
const TEXT_MATCH_EXCEPTIONS: Array<{ file: string; match: string; reason: string }> = [
  {
    file: 'tests/e2e/utils/bucket-already-gone.ts',
    match: 'specified bucket does not exist',
    reason:
      'The shared classifier itself: the words are one of three readings (with the code and ' +
      'the status), and none counts as gone until locateBucket finds the bucket nowhere.',
  },
  {
    file: 'src/lib/iac/index.js',
    match: 'NoSuchBucket',
    reason:
      'Pulumi CLI error text (stack select): the Go SDK prints the S3 code into the message and ' +
      'no $metadata crosses the process boundary; stateBucketConfirmedMissing then asks ' +
      'locateBucket.',
  },
  {
    file: 'src/lib/iac/state-error.js',
    match: 'NoSuchBucket',
    reason: 'Classifies Pulumi CLI stderr; the text is all a child process returns.',
  },
  {
    file: 'src/lib/deploy/walg-staleness.js',
    match: 'NoSuchBucket',
    reason:
      "Classifies wal-g's output text (its Go SDK prints the code); no SDK error object exists.",
  },
  {
    file: 'tests/e2e/utils/classify-failure.ts',
    match: 'NoSuchBucket',
    reason: "Labels a failed step's log text for the report; it decides no bucket's fate.",
  },
];

function findSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        findSourceFiles(join(dir, entry.name), out);
      }
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(relative(ROOT, join(dir, entry.name)));
    }
  }
  return out;
}

const isComment = (trimmed: string) =>
  trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');

const sources = SWEEP_ROOTS.flatMap((root) => findSourceFiles(join(ROOT, root))).map((file) => ({
  file,
  lines: readFileSync(join(ROOT, file), 'utf-8').split('\n'),
}));

interface CallSite {
  file: string;
  line: number;
  call: string;
  /** The catch that follows the call, or '' when none does within reach. */
  catchBody: string;
}

/**
 * Every `.emptyAndDeleteBucket(` call, minus the forwarding adapters (a sweep's
 * `async emptyAndDeleteBucket(...) { return provider.emptyAndDeleteBucket(name) }`,
 * whose caller's catch is the one that decides).
 */
function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const { file, lines } of sources) {
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (isComment(trimmed) || !/\.emptyAndDeleteBucket\(/.test(line)) return;
      const forwarding =
        /^return\s+[\w.]+\.emptyAndDeleteBucket\(/.test(trimmed) &&
        lines.slice(Math.max(0, i - 3), i).some((l) => /async emptyAndDeleteBucket\(/.test(l));
      if (forwarding) return;
      const after = lines.slice(i + 1, i + 16);
      const at = after.findIndex((l) => /\bcatch\s*\(/.test(l));
      const catchBody = at === -1 ? '' : after.slice(at, at + 10).join('\n');
      sites.push({ file, line: i + 1, call: trimmed, catchBody });
    });
  }
  return sites;
}

const isExcepted = (site: CallSite) =>
  CALL_SITE_EXCEPTIONS.some((e) => e.file === site.file && site.call === e.call);

// A regex literal; group 1 is its body.
const REGEX_LITERAL =
  /(?:^|[=(,:!&|?{}[;\s])\/(?![/*])((?:[^/\n\\[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+)\/[dgimsuy]*/g;
const MISSING_BUCKET_SPELLING = /NoSuchBucket|bucket does not exist|specified bucket/i;

function textMatchSites(): Array<{ file: string; line: number; body: string }> {
  const sites: Array<{ file: string; line: number; body: string }> = [];
  for (const { file, lines } of sources) {
    lines.forEach((line, i) => {
      if (isComment(line.trim())) return;
      for (const m of line.matchAll(REGEX_LITERAL)) {
        if (MISSING_BUCKET_SPELLING.test(m[1])) sites.push({ file, line: i + 1, body: m[1] });
      }
    });
  }
  return sites;
}

describe('bucket-already-gone census', () => {
  it('finds the call sites it is meant to police (the walk itself works)', () => {
    const files = new Set(callSites().map((s) => s.file));
    for (const sweep of ['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway']) {
      expect(files).toContain(`tests/e2e/utils/sweep-${sweep}.ts`);
    }
  });

  it('(a) every emptyAndDeleteBucket catch decides "already gone" through the shared classifier', () => {
    const offenders = callSites()
      .filter((site) => !isExcepted(site))
      .filter(
        (site) =>
          !/await\s+classifyBucketDeleteError\(\s*\w+\s*,\s*\(\)\s*=>\s*[\w.]+\.locateBucket\(/.test(
            site.catchBody,
          ),
      )
      .map((s) => `${s.file}:${s.line}  ${s.call}`);
    expect(
      offenders,
      'Route this catch through `await classifyBucketDeleteError(err, () => store.locateBucket(...))` ' +
        '(tests/e2e/utils/bucket-already-gone.ts). It reads the S3 code and the HTTP status, not just ' +
        'the words (an empty message reaches you as "UnknownError"), and it counts a bucket gone only ' +
        'when no region holds it. If this site truly needs no classifier, add it to ' +
        'CALL_SITE_EXCEPTIONS with a reason.',
    ).toEqual([]);
  });

  it('(b) nothing decides a bucket is missing from error TEXT outside the listed text-only sites', () => {
    const offenders = textMatchSites()
      .filter(
        (s) => !TEXT_MATCH_EXCEPTIONS.some((e) => e.file === s.file && s.body.includes(e.match)),
      )
      .map((s) => `${s.file}:${s.line}  /${s.body}/`);
    expect(
      offenders,
      'An SDK error keeps the S3 code on err.name / err.Code and the status on ' +
        'err.$metadata.httpStatusCode; its message can be just "UnknownError". Read those (or use ' +
        'classifyBucketDeleteError), or add the site to TEXT_MATCH_EXCEPTIONS with a reason when its ' +
        "input really is another program's text.",
    ).toEqual([]);
  });

  it('every exception row still names a live site (stale rows are pruned)', () => {
    const calls = callSites();
    const stale = CALL_SITE_EXCEPTIONS.filter(
      (e) => !calls.some((s) => s.file === e.file && s.call === e.call),
    ).map((e) => `${e.file}: ${e.call}`);
    const texts = textMatchSites();
    const staleText = TEXT_MATCH_EXCEPTIONS.filter(
      (e) => !texts.some((s) => s.file === e.file && s.body.includes(e.match)),
    ).map((e) => `${e.file}: ${e.match}`);
    expect([...stale, ...staleText]).toEqual([]);
  });

  it('the classifier needs the locate search: its signature takes one', () => {
    const helper = readFileSync(join(ROOT, 'tests/e2e/utils/bucket-already-gone.ts'), 'utf-8');
    expect(helper).toMatch(
      /export async function classifyBucketDeleteError\(\s*err: unknown,\s*locate:/,
    );
    expect(helper).toMatch(/httpStatusCode/);
  });
});
