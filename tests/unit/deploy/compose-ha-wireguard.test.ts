/**
 * compose-ha WireGuard replication transport (Task 6).
 *
 * Replaces the retired verify-ca TLS transport (writeReplTlsCerts + ssl-enable
 * ALTER SYSTEM + hostssl pg_hba) with a point-to-point WireGuard tunnel:
 *   - host wg0 (UDP 51821) between the two VPS public IPs, brought up by the
 *     SHARED exchangeAndBringUpTunnel helper (keys stay on-node);
 *   - a `repl-gateway` compose service (socat, network_mode: host, NO NET_ADMIN)
 *     that binds the node's OWN tunnel IP :15433 and relays to the local db
 *     (127.0.0.1:5433). Tunnel-IP bind = zero public exposure.
 *   - the standby streams over the tunnel: pg_basebackup + primary_conninfo
 *     target the peer's tunnel IP (10.99.0.1) : gateway port (15433), plaintext.
 *
 * SSH is mocked (compose/index.js sshRun/sshRunAsync); the tunnel bring-up is
 * stubbed (it is SSH-driven and separately unit-tested in wireguard.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture every command + stdin the replication config drives over SSH.
const sshCalls: Array<{ ip: string; command: string; input?: string }> = [];

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = (ip: string, _k: string, command: unknown, options?: { input?: string }) => {
    const c = String(command);
    sshCalls.push({ ip, command: c, input: options?.input });
    // Answer the probes so the functions run to completion offline.
    if (c.includes('pg_is_in_recovery')) return 't';
    if (c.includes('pg_stat_replication')) return 'streaming';
    if (c.includes('SHOW hba_file')) return '/etc/postgresql/pg_hba.conf';
    if (c.includes('pg_isready')) return 'accepting connections';
    // Staged-basebackup exec into the live db container: report staged.
    if (options?.input?.includes('pg_basebackup')) return 'COMPOSE_RESEED_STAGED';
    // docker network subnet resolution (NAT-source hba admission) — the
    // command chain inspects the db container's NetworkIDs then each
    // network's IPAM subnets.
    if (c.includes('IPAM')) return '172.19.0.0/16 ';
    // db volume host-path resolution (docker inspect .Mounts, before the stop).
    if (c.includes('.Mounts')) return '/var/lib/docker/volumes/myapp_db_data/_data';
    // Host-side atomic PGDATA swap (bash -s over stdin).
    if (options?.input?.includes('RESEED_SWAPPED')) return 'RESEED_SWAPPED';
    return '';
  };
  // sshRunChecked must be stubbed alongside sshRun: the real one calls the
  // module-LOCAL sshRun, which vi.mock's export override does not intercept, so
  // leaving it real makes these offline tests attempt actual SSH. Mirrors the
  // production contract — throw when the underlying run answers false.
  const recChecked = async (
    ip: string,
    k: string,
    command: unknown,
    options?: { input?: string; what?: string },
  ) => {
    const out = await rec(ip, k, command, options);
    if (out === false) throw new Error(`${options?.what || 'remote command'} failed on ${ip}`);
    return out;
  };
  return {
    ...actual,
    sshRun: vi.fn(rec),
    sshRunAsync: vi.fn(rec),
    sshRunChecked: vi.fn(recChecked),
  };
});

// Keep the WG constants/builders real; only stub the SSH-driven tunnel bring-up.
vi.mock('../../../src/lib/deploy/wireguard.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    exchangeAndBringUpTunnel: vi
      .fn()
      .mockResolvedValue({ primaryPubKey: 'AAA=', standbyPubKey: 'BBB=' }),
  };
});

const { exchangeAndBringUpTunnel, WG_PRIMARY_IP } = await import(
  '../../../src/lib/deploy/wireguard.js'
);
const {
  configurePrimaryReplication,
  configureStandbyReplication,
  buildReplicationOverlay,
  isComposeStandbyStreaming,
} = await import('../../../src/lib/deploy/compose/ha.js');

const KEY = '/tmp/key';
const PRIMARY = '1.1.1.1';
const STANDBY = '2.2.2.2';

beforeEach(() => {
  process.env.REPL_PASSWORD = 'testreplpass';
  sshCalls.length = 0;
  vi.mocked(exchangeAndBringUpTunnel).mockClear();
});

describe('buildReplicationOverlay', () => {
  it('emits a socat repl-gateway on host netns bound to the self tunnel IP → local db', () => {
    const y = buildReplicationOverlay(WG_PRIMARY_IP);
    // db still published on the replication port for the local relay target.
    expect(y).toContain('"5433:5432"');
    // The gateway relay.
    expect(y).toContain('repl-gateway');
    expect(y).toContain('alpine/socat');
    expect(y).toContain('network_mode: host');
    expect(y).toContain('TCP-LISTEN:15433,bind=10.99.0.1,fork,reuseaddr');
    expect(y).toContain('TCP:127.0.0.1:5433');
  });

  it('bakes the per-node self tunnel IP (never hardcoded to primary)', () => {
    expect(buildReplicationOverlay('10.99.0.2')).toContain('bind=10.99.0.2');
  });

  it('never uses in-container WireGuard (NET_ADMIN) nor any TLS cert material', () => {
    const y = buildReplicationOverlay(WG_PRIMARY_IP);
    expect(y).not.toContain('cap_add');
    expect(y).not.toMatch(/NET_ADMIN/i);
    expect(y).not.toContain('repl-tls');
    expect(y).not.toMatch(/ssl/i);
  });
});

describe('configurePrimaryReplication — WireGuard transport', () => {
  it('brings up the tunnel, creates the replicator role, and opens the tunnel subnet in pg_hba', async () => {
    await configurePrimaryReplication(PRIMARY, STANDBY, KEY, 'myapp');

    // Tunnel brought up once with the two VPS public IPs as endpoints.
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledTimes(1);
    expect(exchangeAndBringUpTunnel).toHaveBeenCalledWith({
      primaryIp: PRIMARY,
      standbyIp: STANDBY,
      sshKeyPath: KEY,
    });

    const all = sshCalls.map((c) => `${c.command}\n${c.input ?? ''}`).join('\n');
    // Replicator role created.
    expect(all).toContain('CREATE ROLE replicator');
    // pg_hba admits the WireGuard tunnel /30 (plain host, scram) — not a peer /32.
    expect(all).toContain('host replication replicator 10.99.0.0/30 scram-sha-256');
    // The primary gateway is started (after the tunnel is up).
    expect(sshCalls.some((c) => c.command.includes('up -d repl-gateway'))).toBe(true);
  });

  it('admits the RESOLVED docker network subnet alongside the WG /30 (post-NAT relay source)', async () => {
    await configurePrimaryReplication(PRIMARY, STANDBY, KEY, 'myapp');
    const all = sshCalls.map((c) => `${c.command}\n${c.input ?? ''}`).join('\n');
    // The subnet is resolved live from the db container's networks (mocked to
    // 172.19.0.0/16) — the docker-proxy NAT makes postgres see the bridge
    // gateway as the replication source, which the WG /30 can never match.
    expect(all).toContain('host replication replicator 172.19.0.0/16 scram-sha-256');
    // Live resolution used → the RFC1918 fallback supernet is NOT admitted.
    expect(all).not.toContain('172.16.0.0/12');
    // Idempotent appends (re-deploys / re-seeds must not grow the file).
    expect(all).toContain('grep -qxF');
    // Applied via reload after the appends.
    expect(all).toContain('pg_reload_conf');
  });

  it('falls back to the docker default-address-pool supernet when subnet resolution fails', async () => {
    const composeIndex = await import('../../../src/lib/deploy/compose/index.js');
    const sshRunMock = composeIndex.sshRun as ReturnType<typeof vi.fn>;
    const orig = sshRunMock.getMockImplementation();
    sshRunMock.mockImplementation(
      async (ip: string, k: string, command: unknown, options?: { input?: string }) => {
        if (String(command).includes('IPAM')) return ''; // resolution yields nothing
        return orig?.(ip, k, command, options);
      },
    );
    try {
      await configurePrimaryReplication(PRIMARY, STANDBY, KEY, 'myapp');
      const all = sshCalls.map((c) => `${c.command}\n${c.input ?? ''}`).join('\n');
      expect(all).toContain('host replication replicator 172.16.0.0/12 scram-sha-256');
      // The WG line is still first.
      expect(all).toContain('host replication replicator 10.99.0.0/30 scram-sha-256');
    } finally {
      sshRunMock.mockImplementation(orig as never);
    }
  });

  it('installs NO TLS: no ssl-enable ALTER SYSTEM, no cert material', async () => {
    await configurePrimaryReplication(PRIMARY, STANDBY, KEY, 'myapp');
    const all = sshCalls.map((c) => `${c.command}\n${c.input ?? ''}`).join('\n');
    expect(all).not.toMatch(/ALTER SYSTEM SET ssl/i);
    expect(all).not.toContain('ssl_cert_file');
    expect(all).not.toContain('repl-tls');
    expect(all).not.toContain('install -o postgres');
    expect(all).not.toContain('hostssl');
  });
});

describe('configureStandbyReplication — WireGuard transport', () => {
  it('streams via the tunnel: basebackup + primary_conninfo target the peer tunnel IP:15433, plaintext', async () => {
    await configureStandbyReplication(STANDBY, PRIMARY, KEY, 'myapp');

    // The standby gateway is started too (failover symmetry: self-exposes local db).
    expect(sshCalls.some((c) => c.command.includes('up -d repl-gateway'))).toBe(true);

    // The pg_basebackup + primary_conninfo script is piped over stdin.
    const scriptCall = sshCalls.find((c) => c.input?.includes('pg_basebackup'));
    expect(scriptCall).toBeDefined();
    const script = scriptCall?.input ?? '';
    // Dials the primary's WireGuard tunnel IP on the gateway relay port.
    expect(script).toContain('-h 10.99.0.1 -p 15433');
    expect(script).toContain('host=10.99.0.1 port=15433');
    expect(script).toContain('sslmode=disable');

    // The basebackup uses a TEMPORARY slot (no -S): an already-streaming standby
    // holds the persistent slot, so -S against it errors "slot is active for PID"
    // (live RCA compose-ha 2026-07-07). Post-swap streaming still uses the
    // persistent slot via primary_slot_name.
    expect(script).not.toMatch(/-S \S/);
    expect(script).toContain("primary_slot_name = 'vibecarbon_standby_slot'");

    // hot_standby forced on in the staged auto.conf (image wal-g.conf ships
    // it off — same image family as k8s).
    expect(script).toContain('hot_standby = on');

    // No app-layer TLS anywhere.
    expect(script).not.toContain('PGSSLMODE');
    expect(script).not.toContain('PGSSLROOTCERT');
    expect(script).not.toContain('verify-ca');
  });

  it('reseeds via stage-while-running → host-side stop → volume swap → start (container-kill fix)', async () => {
    await configureStandbyReplication(STANDBY, PRIMARY, KEY, 'myapp');

    const standbyCmds = sshCalls.filter((c) => c.ip === STANDBY).map((c) => c.command);
    const all = sshCalls.map((c) => `${c.command}\n${c.input ?? ''}`).join('\n');

    // NEVER an in-container pg_ctl stop/start (postgres is the container's
    // PID 1 — stopping it kills the container; compose restarts it as a plain
    // primary and everything after is swallowed).
    expect(all).not.toMatch(/pg_ctl stop/);
    expect(all).not.toMatch(/pg_ctl start/);
    // No throwaway `docker compose run` container either — staging happens in
    // the LIVE db container while postgres is still running.
    expect(all).not.toContain('run --rm');

    // The staged script targets a PGDATA subdir on the db volume, does NOT
    // swap in-place (swap:false), and writes standby.signal + conninfo into
    // the staging BEFORE anything is stopped.
    const stageCall = sshCalls.find((c) => c.input?.includes('pg_basebackup'));
    expect(stageCall?.command).toContain('exec -T db bash');
    const script = stageCall?.input ?? '';
    expect(script).toContain('/var/lib/postgresql/data/.reseed_staging');
    expect(script).not.toMatch(/find \/var\/lib\/postgresql\/data -mindepth 1 -delete/);
    expect(script).toContain('standby.signal');
    expect(script).toContain('primary_conninfo');

    // Ordering: stage (exec) → inspect volume path → stop db → host swap →
    // start db. Stop/start carry the replication overlay flags.
    const stageIdx = standbyCmds.findIndex((c) => c.includes('exec -T db bash'));
    const inspectIdx = standbyCmds.findIndex((c) => c.includes('docker inspect'));
    const stopIdx = standbyCmds.findIndex((c) => c.includes('stop db'));
    const swapIdx = sshCalls.findIndex(
      (c) => c.ip === STANDBY && (c.input?.includes('RESEED_SWAPPED') ?? false),
    );
    const swapIdxInStandby = standbyCmds.indexOf('bash -s 2>&1');
    const startIdx = standbyCmds.findIndex((c) => c.includes('start db'));
    expect(stageIdx).toBeGreaterThanOrEqual(0);
    expect(inspectIdx).toBeGreaterThan(stageIdx);
    expect(stopIdx).toBeGreaterThan(inspectIdx);
    expect(swapIdxInStandby).toBeGreaterThan(stopIdx);
    expect(startIdx).toBeGreaterThan(swapIdxInStandby);
    expect(swapIdx).toBeGreaterThanOrEqual(0);

    // Volume path resolved BEFORE the stop, and the swap targets it.
    const swapCall = sshCalls[swapIdx];
    expect(swapCall.input).toContain("PGDATA='/var/lib/docker/volumes/myapp_db_data/_data'");

    // Replication overlay flags on the compose stop/start invocations.
    expect(standbyCmds[stopIdx]).toContain(
      '-f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.replication.yml',
    );
    expect(standbyCmds[startIdx]).toContain(
      '-f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.replication.yml',
    );
  });

  it('throws loudly (db never stopped) when staging fails, and still classifies a probe-skip', async () => {
    // Make the staged exec return no sentinel → staging failure.
    const composeIndex = await import('../../../src/lib/deploy/compose/index.js');
    const sshRunMock = composeIndex.sshRun as ReturnType<typeof vi.fn>;
    const orig = sshRunMock.getMockImplementation();
    sshRunMock.mockImplementation(
      async (ip: string, k: string, command: unknown, options?: { input?: string }) => {
        if (options?.input?.includes('pg_basebackup')) return 'bash: something exploded';
        return orig?.(ip, k, command, options);
      },
    );

    await expect(configureStandbyReplication(STANDBY, PRIMARY, KEY, 'myapp')).rejects.toThrow(
      /staging the basebackup .* failed/i,
    );
    // Nothing destructive happened: no stop, no swap.
    expect(sshCalls.some((c) => c.command.includes('stop db'))).toBe(false);

    // Probe-skip path: the script's skip message classifies as unreachable-primary.
    sshCalls.length = 0;
    sshRunMock.mockImplementation(
      async (ip: string, k: string, command: unknown, options?: { input?: string }) => {
        if (options?.input?.includes('pg_basebackup')) {
          return '[compose-ha-repl] primary postgres at 10.99.0.1:15433 not reachable from standby — skipping pg_basebackup.';
        }
        return orig?.(ip, k, command, options);
      },
    );
    await expect(configureStandbyReplication(STANDBY, PRIMARY, KEY, 'myapp')).rejects.toThrow(
      /repl-gateway .* not reachable/i,
    );
    expect(sshCalls.some((c) => c.command.includes('stop db'))).toBe(false);

    sshRunMock.mockImplementation(orig as never);
  });
});

describe('isComposeStandbyStreaming (standby-side wal-receiver signal for failover skip)', () => {
  it('returns true only when pg_stat_wal_receiver.status is "streaming"', async () => {
    const composeIndex = await import('../../../src/lib/deploy/compose/index.js');
    const sshRunMock = composeIndex.sshRun as ReturnType<typeof vi.fn>;
    const orig = sshRunMock.getMockImplementation();
    sshRunMock.mockImplementation(async (ip: string, _k: string, command: unknown) => {
      sshCalls.push({ ip, command: String(command) });
      if (String(command).includes('pg_stat_wal_receiver')) return 'streaming\n';
      return '';
    });
    try {
      await expect(isComposeStandbyStreaming(STANDBY, KEY, '/opt/myapp')).resolves.toBe(true);
      // The query targets the STANDBY's own walreceiver view.
      const q = sshCalls.find((c) => c.command.includes('pg_stat_wal_receiver'));
      expect(q?.ip).toBe(STANDBY);
      expect(q?.command).toContain('SELECT status FROM pg_stat_wal_receiver');
    } finally {
      sshRunMock.mockImplementation(orig as never);
    }
  });

  it('returns false when the walreceiver view is empty (not streaming)', async () => {
    const composeIndex = await import('../../../src/lib/deploy/compose/index.js');
    const sshRunMock = composeIndex.sshRun as ReturnType<typeof vi.fn>;
    const orig = sshRunMock.getMockImplementation();
    sshRunMock.mockImplementation(async () => '');
    try {
      await expect(isComposeStandbyStreaming(STANDBY, KEY, '/opt/myapp')).resolves.toBe(false);
    } finally {
      sshRunMock.mockImplementation(orig as never);
    }
  });

  it('returns false (never throws) when the exec fails', async () => {
    const composeIndex = await import('../../../src/lib/deploy/compose/index.js');
    const sshRunMock = composeIndex.sshRun as ReturnType<typeof vi.fn>;
    const orig = sshRunMock.getMockImplementation();
    sshRunMock.mockImplementation(async () => {
      throw new Error('db container down');
    });
    try {
      await expect(isComposeStandbyStreaming(STANDBY, KEY, '/opt/myapp')).resolves.toBe(false);
    } finally {
      sshRunMock.mockImplementation(orig as never);
    }
  });
});
