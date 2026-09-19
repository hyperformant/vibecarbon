import { describe, expect, it } from 'vitest';
import {
  classifyContainer,
  formatContainerRow,
  rowsFromDockerPs,
} from '../../../src/lib/status/container-rows.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('rowsFromDockerPs', () => {
  it('keeps only this project’s containers and splits the three tab fields', () => {
    const listing = [
      'letsgo-db\trunning\tUp 1 hour (healthy)',
      'letsgo-kong\texited\tExited (128) 24 minutes ago',
      'vibecarbon-kong\trunning\tUp 2 hours (healthy)',
      '',
    ].join('\n');
    expect(rowsFromDockerPs(listing, 'letsgo')).toEqual([
      { container: 'db', state: 'running', status: 'Up 1 hour (healthy)' },
      { container: 'kong', state: 'exited', status: 'Exited (128) 24 minutes ago' },
    ]);
  });

  it('tolerates a malformed line by leaving state and status empty', () => {
    expect(rowsFromDockerPs('letsgo-weird\n', 'letsgo')).toEqual([
      { container: 'weird', state: '', status: '' },
    ]);
  });

  it('returns [] for empty, null, or foreign-only listings', () => {
    expect(rowsFromDockerPs('', 'letsgo')).toEqual([]);
    expect(rowsFromDockerPs(null, 'letsgo')).toEqual([]);
    expect(rowsFromDockerPs('other-db\trunning\tUp', 'letsgo')).toEqual([]);
  });
});

describe('formatContainerRow', () => {
  const row = (over: Record<string, unknown>) => ({
    name: 'Kong Gateway',
    container: 'kong',
    health: 'healthy',
    label: 'healthy',
    detail: '',
    latencyMs: 0,
    ...over,
  });

  it('renders healthy with a dim label and no tail', () => {
    expect(stripAnsi(formatContainerRow(row({})))).toBe(
      '  Kong Gateway                ● healthy  ',
    );
  });

  it('renders unhealthy with the detail as tail', () => {
    expect(
      stripAnsi(
        formatContainerRow(
          row({ health: 'unhealthy', label: 'exited', detail: 'Exited (128) 3 hours ago' }),
        ),
      ),
    ).toBe('  Kong Gateway                ● exited  Exited (128) 3 hours ago');
  });

  it('renders latency when there is no detail', () => {
    expect(stripAnsi(formatContainerRow(row({ latencyMs: 17 })))).toBe(
      '  Kong Gateway                ● healthy  17ms',
    );
  });

  it('uses the hollow icon for done and unknown', () => {
    expect(stripAnsi(formatContainerRow(row({ health: 'done', label: 'done' })))).toBe(
      '  Kong Gateway                ○ done  ',
    );
    expect(
      stripAnsi(
        formatContainerRow(row({ health: 'unknown', label: 'unknown', detail: 'gateway down' })),
      ),
    ).toBe('  Kong Gateway                ○ unknown  gateway down');
  });

  it('honours a custom indent', () => {
    expect(stripAnsi(formatContainerRow(row({}), '      '))).toBe(
      '      Kong Gateway                ● healthy  ',
    );
  });

  it('colours by health: green healthy, red unhealthy, yellow starting', () => {
    expect(formatContainerRow(row({}))).toContain('\x1b[32m●');
    expect(formatContainerRow(row({ health: 'unhealthy', label: 'unhealthy' }))).toContain(
      '\x1b[31m●',
    );
    expect(formatContainerRow(row({ health: 'starting', label: 'starting' }))).toContain(
      '\x1b[33m●',
    );
  });
});

describe('classifyContainer (moved)', () => {
  it('still classifies a healthy running container', () => {
    expect(classifyContainer('auth', 'running', 'Up 1m (healthy)')).toEqual({
      health: 'healthy',
      label: 'healthy',
      detail: '',
    });
  });
});
