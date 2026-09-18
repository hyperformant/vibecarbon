import { describe, expect, it } from 'vitest';
import { classifyContainer, parseKongHostPort } from '../../../src/status.js';

describe('classifyContainer', () => {
  it('maps a running container with a passing healthcheck to healthy', () => {
    expect(classifyContainer('auth', 'running', 'Up 15 minutes (healthy)')).toEqual({
      health: 'healthy',
      label: 'healthy',
      detail: '',
    });
  });

  it('maps a running container with a failing healthcheck to unhealthy', () => {
    expect(classifyContainer('auth', 'running', 'Up 15 minutes (unhealthy)')).toEqual({
      health: 'unhealthy',
      label: 'unhealthy',
      detail: '',
    });
  });

  it('maps a running container whose healthcheck is still starting to starting', () => {
    expect(classifyContainer('db', 'running', 'Up 3 seconds (health: starting)')).toEqual({
      health: 'starting',
      label: 'starting',
      detail: '',
    });
  });

  it('counts a running container with no healthcheck as healthy, labelled running', () => {
    expect(classifyContainer('traefik', 'running', 'Up 15 minutes')).toEqual({
      health: 'healthy',
      label: 'running',
      detail: '',
    });
  });

  it('reports an exited container as unhealthy with the Docker status as detail', () => {
    expect(classifyContainer('kong', 'exited', 'Exited (128) 24 minutes ago')).toEqual({
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (128) 24 minutes ago',
    });
  });

  it('treats a *-setup one-shot container that exited 0 as done', () => {
    expect(classifyContainer('metabase-setup', 'exited', 'Exited (0) 2 hours ago')).toEqual({
      health: 'done',
      label: 'done',
      detail: '',
    });
  });

  it('treats a *-setup one-shot container that exited non-zero as unhealthy', () => {
    expect(classifyContainer('n8n-setup', 'exited', 'Exited (1) 2 hours ago')).toEqual({
      health: 'unhealthy',
      label: 'exited',
      detail: 'Exited (1) 2 hours ago',
    });
  });

  it('does not treat a core service that exited 0 as done', () => {
    expect(classifyContainer('db', 'exited', 'Exited (0) 5 minutes ago').health).toBe('unhealthy');
  });

  it('reports restarting as unhealthy with the Docker status as detail', () => {
    expect(classifyContainer('realtime', 'restarting', 'Restarting (1) 5 seconds ago')).toEqual({
      health: 'unhealthy',
      label: 'restarting',
      detail: 'Restarting (1) 5 seconds ago',
    });
  });

  it('reports any other state (created, paused, dead) as unhealthy labelled by state', () => {
    expect(classifyContainer('app', 'created', 'Created')).toEqual({
      health: 'unhealthy',
      label: 'created',
      detail: 'Created',
    });
    expect(classifyContainer('app', 'paused', 'Up 2 minutes (Paused)').label).toBe('paused');
  });
});

describe('parseKongHostPort', () => {
  it('returns the host port from docker port output', () => {
    expect(parseKongHostPort('0.0.0.0:8000\n[::]:8000\n')).toBe(8000);
  });

  it('honours a non-default binding', () => {
    expect(parseKongHostPort('0.0.0.0:8100\n')).toBe(8100);
  });

  it('returns null for empty output (container not running)', () => {
    expect(parseKongHostPort('')).toBeNull();
    expect(parseKongHostPort(null)).toBeNull();
  });

  it('returns null for unparseable output', () => {
    expect(parseKongHostPort('Error: No such container: letsgo-kong')).toBeNull();
  });
});
