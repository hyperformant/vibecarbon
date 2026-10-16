/**
 * The k8s app NetworkPolicy must let the app reach an SMTP server.
 *
 * Pre-existing bug: app-policy admitted only 443 to the internet, so with
 * SMTP configured every email the app sends (auth verification, password
 * reset, magic link, transactional) timed out on 587 on k8s while the same
 * config worked on compose (whose stack has no egress policy). Auth now
 * sends its own emails from the app, which makes this load-bearing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('k8s: the app can reach an SMTP server', () => {
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  type Doc = any;
  const docs: Doc[] = [];
  loadAll(read('carbon/k8s/base/app/network-policy.yaml'), (d) => {
    if (d) docs.push(d);
  });
  const policy = docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'app-policy');

  it('admits egress to the SMTP ports on public addresses only', () => {
    const rules = (policy?.spec.egress ?? []).filter((rule: Doc) =>
      (rule.ports ?? []).some((port: { port: number }) => port.port === 587),
    );
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule.ports).toEqual([25, 465, 587, 2525].map((port) => ({ protocol: 'TCP', port })));
    expect(rule.to).toEqual([
      {
        ipBlock: {
          cidr: '0.0.0.0/0',
          except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
        },
      },
    ]);
  });
});
