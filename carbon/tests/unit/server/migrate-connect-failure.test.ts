import { describe, expect, it, vi } from 'vitest';

/**
 * runMigrationsOnOwnConnection opens its own pg.Client (not a pool client).
 * A connect that fails (database refused or unreachable) must still end the
 * client: its socket and connect timer must not outlive the failure that
 * startup then waits out.
 */
const { client } = vi.hoisted(() => ({
  client: {
    connect: vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    }),
    query: vi.fn(),
    end: vi.fn(async () => undefined),
  },
}));
vi.mock('pg', () => ({
  default: {
    Client: vi.fn(function Client() {
      return client;
    }),
  },
}));

const { runMigrationsOnOwnConnection } = await import('@server/db/migrate');

describe('runMigrationsOnOwnConnection: connect failure', () => {
  it('rejects with the connect error and still ends the client', async () => {
    await expect(
      runMigrationsOnOwnConnection(
        { host: '127.0.0.1', port: 5432, user: 'u', password: 'p', database: 'd' },
        '/nonexistent',
      ),
    ).rejects.toThrow('ECONNREFUSED');
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(client.query).not.toHaveBeenCalled();
  });
});
