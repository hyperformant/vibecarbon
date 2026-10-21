/**
 * Census: "the primary's tunnel address" is resolved from the role mapping,
 * never hard-coded (HA-correctness Task 3b, ruling R11).
 *
 * WireGuard addresses stay bound to BIRTH identity: the `<env>-primary` stack's
 * node keeps 10.99.0.1 and the `<env>-standby` node keeps 10.99.0.2, whatever
 * their roles after a failover. A connect target spelled `WG_PRIMARY_IP` is
 * therefore only right until the first failover, and then it dials the retired
 * node (the class that made compose-HA failover one-way: the reseed copied the
 * retired node from itself).
 *
 * Rule: outside `src/lib/deploy/wireguard.js` (the definitions and `wgIpOf`,
 * the one stack-to-address helper), no file under `src/` names
 * `WG_PRIMARY_IP` / `WG_STANDBY_IP` or spells a tunnel address literal.
 * Everyone else asks `wgIpOf({ stackIdentity })`. The one exemption is k8s-ha's
 * pilot-light gateway (`k8s/ha/index.js`), which has its own role model (its
 * clusters reconverge by `ha.primary.stack`, PR #232).
 *
 * Parsed with vite's parseAst, so comments never count and a namespace access
 * (`wg.WG_PRIMARY_IP`) does.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const NAMES = new Set(['WG_PRIMARY_IP', 'WG_STANDBY_IP']);
const TUNNEL_LITERAL = /^10\.99\.0\.[12]$/;
const ALLOWED = new Map([
  ['src/lib/deploy/wireguard.js', 'the definitions and wgIpOf, the stack-to-address helper'],
  ['src/lib/deploy/k8s/ha/index.js', "k8s-ha's pilot-light gateway, its own role model (#232)"],
]);

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

function walk(node: Node, fn: (n: Node) => void) {
  fn(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    for (const child of Array.isArray(v) ? v : [v]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') walk(child, fn);
    }
  }
}

/** Every place a file names a tunnel-address constant or spells a tunnel literal. */
function findTunnelAddressUses(path: string, text: string): string[] {
  const ast = parseAst(text);
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
  const out: string[] = [];
  walk(ast, (n) => {
    const named = n.type === 'Identifier' && NAMES.has(n.name);
    const literal =
      (n.type === 'Literal' && typeof n.value === 'string' && TUNNEL_LITERAL.test(n.value)) ||
      (n.type === 'TemplateElement' && /10\.99\.0\.[12]\b/.test(n.value?.raw ?? ''));
    if (named || literal) out.push(`${path}:${lineOf(n.start)}`);
  });
  return out;
}

function srcFiles() {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
    { cwd: REPO, encoding: 'utf-8' },
  );
  return listed
    .split('\n')
    .filter((f) => f.endsWith('.js'))
    .map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf-8') }));
}

describe('compose-HA primary tunnel address census (R11)', () => {
  it('no file outside the allowlist names a tunnel address constant or literal', () => {
    const offenders = srcFiles()
      .filter(({ path }) => !ALLOWED.has(path))
      .flatMap(({ path, text }) => findTunnelAddressUses(path, text));
    expect(
      offenders,
      'resolve the tunnel address through wgIpOf({ stackIdentity }) from the node stack ' +
        '(compose/ha-role-swap.js composeHaStackOf): the address follows birth identity, the ' +
        'role does not',
    ).toEqual([]);
  });

  it('every allowlisted file still exists and still needs its exemption', () => {
    const files = new Map(srcFiles().map((f) => [f.path, f.text]));
    for (const path of ALLOWED.keys()) {
      expect(files.has(path), `${path} is gone: drop it from ALLOWED`).toBe(true);
      expect(findTunnelAddressUses(path, files.get(path) ?? '').length).toBeGreaterThan(0);
    }
  });

  it('the compose consumers resolve through wgIpOf', () => {
    for (const path of ['src/lib/deploy/effects/compose-ha.js', 'src/lib/deploy/compose/ha.js']) {
      expect(readFileSync(join(REPO, path), 'utf-8')).toContain('wgIpOf(');
    }
  });

  describe('planted fixtures', () => {
    const imp = "import { WG_PRIMARY_IP, wgIpOf } from '../wireguard.js';\n";
    const flag = (src: string) => findTunnelAddressUses('fixture.js', src);

    it('flags a hard-coded connect target', () => {
      expect(flag(`${imp}export const o = { primaryHost: WG_PRIMARY_IP };`)).not.toEqual([]);
    });

    it('flags a relay target built from the constant', () => {
      expect(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text.
        flag("import { WG_STANDBY_IP } from './w.js';\nconst t = `TCP:${WG_STANDBY_IP}:15433`;"),
      ).not.toEqual([]);
    });

    it('flags a namespace access and a spelled literal', () => {
      expect(flag("import * as wg from './w.js';\nconst a = wg.WG_PRIMARY_IP;")).not.toEqual([]);
      expect(flag("const a = '10.99.0.2';")).not.toEqual([]);
      expect(flag('const a = `host=10.99.0.1 port=15433`;')).not.toEqual([]);
    });

    it('passes the role-resolved form and comments that name the constant', () => {
      expect(
        flag(
          "import { wgIpOf } from '../wireguard.js';\n" +
            '// the old WG_PRIMARY_IP connect target (10.99.0.1) is gone\n' +
            "export const o = { primaryHost: wgIpOf({ stackIdentity: 'standby' }) };",
        ),
      ).toEqual([]);
    });
  });
});
