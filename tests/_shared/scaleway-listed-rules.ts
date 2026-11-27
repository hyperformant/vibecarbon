/**
 * A Scaleway security group's rules as the Instance API lists them
 * (`GET /instance/v1/zones/{zone}/security_groups/{id}/rules`), recorded in
 * terraform-provider-scaleway v2.92.1's cassettes
 * internal/services/instance/testdata/security-group-basic.cassette.yaml and
 * internal/services/instance/testdata/security-group-rules-ip-ranges.cassette.yaml:
 *
 *   - Six `editable: false` outbound SMTP drops come first, on positions 1
 *     to 6 of their own. The editable rules count their positions from 1.
 *   - A host range is listed bare: `1.2.3.0/32` reads back `1.2.3.0`, and an
 *     IPv6 /128 reads back as the bare address. Wider ranges keep their
 *     prefix.
 *   - `dest_port_to` is null on a single-port rule.
 *
 * These fixtures build rows in that form, so a test certifies what the REST
 * writers do with a real listing, not with the form the CLI writes.
 */

type Rule = Record<string, unknown>;

/** The rules Scaleway lists first on every group: outbound SMTP, dropped. */
export const SCALEWAY_SMTP_DROPS: Rule[] = ['0.0.0.0/0', '::/0'].flatMap((ipRange, family) =>
  [25, 465, 587].map((port, i) => ({
    id: `smtp-${family * 3 + i + 1}`,
    protocol: 'TCP',
    direction: 'outbound',
    ip_range: ipRange,
    dest_ip_range: null,
    dest_port_from: port,
    dest_port_to: null,
    position: family * 3 + i + 1,
    editable: false,
    action: 'drop',
  })),
);

/** A range as the listing writes it: a host network bare, any other as given. */
export const listedRange = (cidr: string) => cidr.replace(/\/(?:32|128)$/, '');

/**
 * One single-port rule (the program's `inboundRules` form) as the listing
 * returns it, at `position` among the editable rules.
 */
export const listedRule = (
  r: { action: unknown; protocol: unknown; port: unknown; ipRange: unknown },
  position: number,
): Rule => ({
  id: `rule-${position}`,
  protocol: r.protocol,
  direction: 'inbound',
  ip_range: listedRange(String(r.ipRange)),
  dest_ip_range: null,
  dest_port_from: r.port,
  dest_port_to: null,
  position,
  editable: true,
  action: r.action,
});

/** A group's whole listing: Scaleway's SMTP drops, then the given inbound rules. */
export const listedRules = (
  rules: { action: unknown; protocol: unknown; port: unknown; ipRange: unknown }[],
): Rule[] => [...SCALEWAY_SMTP_DROPS, ...rules.map((r, i) => listedRule(r, i + 1))];
