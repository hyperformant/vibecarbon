/**
 * Census: every `vibecarbon deploy` flag reaches the runtime.
 *
 * Class: "a flag the deploy accepts and then drops". Instance that bought
 * this: `deploy -restore` (C1). The flag travelled args.restore ->
 * deploymentConfig.restore -> options.restore, fed the k3s-apply input hash,
 * and stopped there: applyK3sManifests documented it as "accepted for the
 * caller's input hash and ignored here". A k8s `deploy -restore latest`
 * deployed an EMPTY database and reported success.
 *
 * The walk (tests/unit/helpers/runtime-reach-walk.ts) starts from each SPEC
 * flag's keys on the args object that buildLegacyArgs builds, follows every
 * pass-through (`key: options.key`) under src/lib/deploy, and asks for at
 * least one reader that USES the value: one that is not the input hash, not
 * a validation-only check, and not another pass-through.
 *
 * Two allowlists, each entry with its reason:
 * - NON_RENDERING_READERS: functions whose reads do not count.
 * - HASH_ONLY_FLAGS: flags allowed to feed only the input hash. Empty today;
 *   an entry that gains a use is stale and fails.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatReachSites,
  loadSourceTree,
  maskSource,
  type NonRenderingReader,
  walkRuntimeReach,
} from '../helpers/runtime-reach-walk.js';

const DEPLOY_SRC = readFileSync('src/deploy.js', 'utf8');
const FILES = loadSourceTree('src/lib/deploy');

/** Readers that see the value without rendering it anywhere. */
const NON_RENDERING_READERS: NonRenderingReader[] = [
  {
    file: 'src/lib/deploy/k8s/k3s.js',
    fn: 'buildK3sApplyInputs',
    reason: 'the k3s-apply step input hash: decides whether to re-apply, renders nothing',
  },
  {
    file: 'src/lib/deploy/k8s/k3s.js',
    fn: 'assertDeployRestorePoint',
    reason: 'validation only: refuses an incomplete restore point before any apply',
  },
];

/** Flags allowed to reach only the input hash. Each entry needs a reason. */
const HASH_ONLY_FLAGS: Record<string, string> = {};

/** SPEC flags answered by the parser before main runs: never reach args. */
const PARSE_ONLY_FLAGS: Record<string, string> = {
  h: 'parseFlagsOrExit prints help and returns before main',
  v: 'parseFlagsOrExit prints the version and returns before main',
};

function specFlags(): string[] {
  const start = DEPLOY_SRC.indexOf('flags: [');
  const end = DEPLOY_SRC.indexOf('examples: [', start);
  return [...DEPLOY_SRC.slice(start, end).matchAll(/\{\s*name: '([\w-]+)'/g)].map((m) => m[1]);
}

/** flag -> the args keys buildLegacyArgs derives from it. */
function legacyArgKeys(): Map<string, string[]> {
  const code = maskSource(DEPLOY_SRC);
  const head = code.indexOf('function buildLegacyArgs(');
  const bodyStart = code.indexOf('{', code.indexOf(')', head));
  let depth = 0;
  let bodyEnd = bodyStart;
  for (let k = bodyStart; k < code.length; k++) {
    if (code[k] === '{') depth += 1;
    if (code[k] === '}') {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = k;
        break;
      }
    }
  }
  // Masked, so `values['server-type']` reads as `values['           ']`: take
  // the flag names from the original text at the same offsets.
  const body = DEPLOY_SRC.slice(bodyStart, bodyEnd);
  const flagsIn = (text: string) => [
    ...[...text.matchAll(/values\.([\w]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/values\['([\w-]+)'\]/g)].map((m) => m[1]),
  ];
  const locals = new Map<string, string[]>();
  for (const m of body.matchAll(/const (\w+) = ([^;]+);/g)) locals.set(m[1], flagsIn(m[2]));
  const out = new Map<string, string[]>();
  for (const m of body.matchAll(/^ {4}(\w+): (.+)$/gm)) {
    const [, key, expr] = m;
    const flags = new Set(flagsIn(expr));
    for (const [local, from] of locals) {
      if (new RegExp(`\\b${local}\\b`).test(expr)) for (const f of from) flags.add(f);
    }
    for (const f of flags) out.set(f, [...(out.get(f) ?? []), key]);
  }
  return out;
}

const walkFlag = (keys: string[]) =>
  walkRuntimeReach({ files: FILES, start: keys, nonRendering: NON_RENDERING_READERS });

describe('every deploy flag reaches the runtime', () => {
  const flags = specFlags();
  const mapped = legacyArgKeys();

  it('finds the SPEC flags and their args keys (guards against walking nothing)', () => {
    expect(flags).toEqual(expect.arrayContaining(['restore', 'mode', 'region', 'allow-degraded']));
    expect(mapped.get('restore')).toEqual(['restore']);
    expect(mapped.get('mode')).toEqual(expect.arrayContaining(['compose', 'k8s', 'ha']));
    expect(mapped.get('server-type')).toEqual(['serverType']);
  });

  for (const flag of specFlags()) {
    it(`-${flag}`, () => {
      if (PARSE_ONLY_FLAGS[flag]) {
        expect(mapped.has(flag), `-${flag} is parse-only but buildLegacyArgs maps it`).toBe(false);
        return;
      }
      const keys = mapped.get(flag);
      expect(keys, `-${flag} is in SPEC but buildLegacyArgs drops it`).toBeTruthy();
      const { sites } = walkFlag(keys as string[]);
      const uses = sites.filter((s) => s.kind === 'use');
      if (HASH_ONLY_FLAGS[flag]) {
        expect(uses, `-${flag} is allowlisted hash-only but has uses (stale entry)`).toEqual([]);
        return;
      }
      expect(
        uses.length,
        `-${flag} (args ${(keys as string[]).join(', ')}) never reaches a runtime reader under src/lib/deploy.\n` +
          `Walked:\n${formatReachSites(sites) || '  (no reads at all)'}`,
      ).toBeGreaterThan(0);
    });
  }

  it('-restore reaches the infra Secret through applyK3sManifests', () => {
    const { sites } = walkFlag(['restore']);
    const uses = sites.filter((s) => s.kind === 'use');
    expect(
      uses.some(
        (s) => s.file === 'src/lib/deploy/k8s/k3s.js' && /restoreMarkerStringData\(/.test(s.text),
      ),
      formatReachSites(sites),
    ).toBe(true);
  });
});

describe('the runtime-reach walk', () => {
  const file = (src: string) => [{ path: 'x.js', src }];

  it('a pass-through into a function that ignores the value is not a use', () => {
    const { sites } = walkRuntimeReach({
      files: file(
        [
          'function inner({ other }) { return other; }',
          'export function outer(options) {',
          '  return inner({ other: 1, flag: options.flag });',
          '}',
        ].join('\n'),
      ),
      start: ['flag'],
    });
    expect(sites.map((s) => s.kind)).toEqual(['forward']);
  });

  it('follows a pass-through into a destructuring function that uses it', () => {
    const { sites } = walkRuntimeReach({
      files: file(
        [
          'function inner({ renamed }) {',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text fed to the walk
          '  return `x=${renamed}`;',
          '}',
          'export function outer(options) {',
          '  return inner({ renamed: options.flag || null });',
          '}',
        ].join('\n'),
      ),
      start: ['flag'],
    });
    expect(sites.map((s) => `${s.kind}:${s.name}`)).toEqual(['forward:flag', 'use:renamed']);
  });

  it('a function that destructures the same name but is never handed the value is not reached', () => {
    const { sites } = walkRuntimeReach({
      files: file(
        [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text fed to the walk
          'function bystander({ flag }) { return `x=${flag}`; }',
          'function inner({ other }) { return other; }',
          'export function outer(options) {',
          '  return inner({ flag: options.flag });',
          '}',
        ].join('\n'),
      ),
      start: ['flag'],
    });
    expect(sites.map((s) => s.kind)).toEqual(['forward']);
  });

  it('reads in a non-rendering reader are excluded, with the reason', () => {
    const { sites } = walkRuntimeReach({
      files: file(
        ['function hash({ flag }) { return String(flag); }', 'hash({ flag: options.flag });'].join(
          '\n',
        ),
      ),
      start: ['flag'],
      nonRendering: [{ file: 'x.js', fn: 'hash', reason: 'input hash' }],
    });
    expect(sites.map((s) => s.kind)).toEqual(['forward', 'excluded']);
    expect(sites[1].reason).toBe('input hash');
  });

  it('ignores comments, strings and writes', () => {
    const { sites } = walkRuntimeReach({
      files: file(
        ['// options.flag in a comment', "const s = 'options.flag';", 'options.flag = 1;'].join(
          '\n',
        ),
      ),
      start: ['flag'],
    });
    expect(sites).toEqual([]);
  });

  it('a template interpolation is a use', () => {
    const { sites } = walkRuntimeReach({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text fed to the walk
      files: file('const cmd = `run ${options.flag}`;'),
      start: ['flag'],
    });
    expect(sites.map((s) => s.kind)).toEqual(['use']);
  });

  it('a stale non-rendering entry fails loudly', () => {
    expect(() =>
      walkRuntimeReach({
        files: file('const a = 1;'),
        start: ['flag'],
        nonRendering: [{ file: 'x.js', fn: 'gone', reason: 'r' }],
      }),
    ).toThrow(/stale nonRendering entry/);
  });
});
