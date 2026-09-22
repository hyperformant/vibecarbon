import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  displayCommand,
  menuLines,
  stateLines,
  stepBlock,
} from '../../../../src/lib/next/render.js';

function plain(lines: string[]): string[] {
  return lines.map((line) => stripVTControlCharacters(line));
}

describe('displayCommand', () => {
  it('returns null when command is null', () => {
    expect(displayCommand(null)).toBeNull();
  });

  it('joins a plain command with the vibecarbon prefix', () => {
    expect(displayCommand(['up'])).toBe('vibecarbon up');
  });

  it('appends envName for an envScoped command when envName is given', () => {
    expect(displayCommand(['scale'], { envName: 'prod', envScoped: true })).toBe(
      'vibecarbon scale prod',
    );
  });

  it('leaves an envScoped command unchanged when envName is not given', () => {
    expect(displayCommand(['scale'], { envScoped: true })).toBe('vibecarbon scale');
  });

  it('leaves a <name> placeholder as-is when the command is not envScoped', () => {
    expect(displayCommand(['deploy', '<name>'], { envName: 'prod', envScoped: false })).toBe(
      'vibecarbon deploy <name>',
    );
  });
});

describe('stepBlock', () => {
  it('renders the why, then a commented title line, then the command', () => {
    const step = {
      id: 'up' as const,
      title: 'Start local development',
      why: 'Starts the Docker services and dev server so you can build and test locally.',
      command: ['up'],
      display: 'vibecarbon up',
      canLaunch: true,
      blocksTerminal: true,
      optional: false,
    };
    const lines = plain(stepBlock(step));
    expect(lines[0]).toBe(step.why);
    expect(lines[1]).toBe('');
    expect(lines.some((line) => line.includes('# Start local development'))).toBe(true);
    expect(lines.some((line) => line.includes('vibecarbon up'))).toBe(true);
  });

  it('trims the trailing blank line', () => {
    const step = {
      id: 'configure' as const,
      title: 'Configure services (optional)',
      why: 'Sets up cloud provider credentials, payments, OAuth, SMTP and CI/CD before your first deploy. Deploy works without it.',
      command: ['configure'],
      display: 'vibecarbon configure',
      canLaunch: true,
      blocksTerminal: false,
      optional: true,
    };
    const lines = stepBlock(step);
    expect(lines[lines.length - 1]).not.toBe('');
  });
});

describe('menuLines', () => {
  const items = [
    { value: 'status', label: 'Check status', command: ['status'], envScoped: false },
    { value: 'scale', label: 'Scale an environment', command: ['scale'], envScoped: true },
    { value: 'nothing', label: 'Nothing right now', command: null, envScoped: false },
  ];

  it('includes vibecarbon scale prod for a scale item when envName is given', () => {
    const lines = plain(menuLines(items, { envName: 'prod' }));
    expect(lines.some((line) => line.includes('vibecarbon scale prod'))).toBe(true);
  });

  it('skips items whose command is null', () => {
    const lines = plain(menuLines(items, { envName: 'prod' }));
    expect(lines.some((line) => line.includes('Nothing right now'))).toBe(false);
  });

  it('trims the trailing blank line', () => {
    const lines = menuLines(items, { envName: 'prod' });
    expect(lines[lines.length - 1]).not.toBe('');
  });
});

describe('stateLines', () => {
  it('reports the no-project sentence', () => {
    expect(stateLines({ kind: 'no-project', cwd: '/tmp/empty' })).toEqual([
      'Not in a Vibecarbon project (needs .vibecarbon.json and docker-compose.yml).',
    ]);
  });

  it('reports the project name, running containers, and no configured services', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: ['web', 'db'] },
      configured: { any: false, features: [], providers: false },
      environments: [],
    };
    expect(stateLines(state)).toEqual([
      'Project: acme',
      'Local dev: running (2 containers)',
      'Configured services: none',
      'Deployed: none',
    ]);
  });

  it('names the project root and the cwd below it when run from a subdirectory', () => {
    const state = {
      kind: 'project' as const,
      cwd: '/home/dev/acme',
      subdir: '/home/dev/acme/src/client',
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [],
    };
    expect(stateLines(state)).toEqual([
      'Project: acme',
      'You are in src/client, below the project root.',
      'Project root: /home/dev/acme',
      'Local dev: not running',
      'Configured services: none',
      'Deployed: none',
    ]);
  });

  it('reports local dev not running when Docker is available', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [],
    };
    expect(stateLines(state)).toEqual([
      'Project: acme',
      'Local dev: not running',
      'Configured services: none',
      'Deployed: none',
    ]);
  });

  it('reports Docker not running or not installed when Docker is unavailable', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: false, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [],
    };
    expect(stateLines(state)).toEqual([
      'Project: acme',
      'Docker: not running or not installed',
      'Configured services: none',
      'Deployed: none',
    ]);
  });

  it('joins configured feature labels', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: true, features: ['CI/CD', 'OAuth'], providers: false },
      environments: [],
    };
    expect(stateLines(state)).toContain('Configured: CI/CD, OAuth');
  });

  it('appends the provider credentials suffix when providers is true', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: true, features: ['CI/CD'], providers: true },
      environments: [],
    };
    expect(stateLines(state)).toContain('Configured: CI/CD (provider credentials saved)');
  });

  it('reports the provider suffix alone when providers is true and no feature is configured', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: true, features: [], providers: true },
      environments: [],
    };
    expect(stateLines(state)).toContain('Configured: (provider credentials saved)');
  });

  it('reports a deployed environment with all parts present', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [
        {
          name: 'prod',
          status: 'deployed',
          deployMode: 'compose',
          region: 'fsn1',
          domain: 'example.com',
          deployedAt: '2026-09-20T12:00:00.000Z',
        },
      ],
    };
    expect(stateLines(state, { now: new Date('2026-09-20T18:00:00.000Z') })).toContain(
      'Deployed: prod (compose, fsn1, example.com, deployed today)',
    );
  });

  it('omits null parts (no domain) for a deployed environment', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [
        {
          name: 'prod',
          status: 'deployed',
          deployMode: 'compose',
          region: 'fsn1',
          domain: null,
          deployedAt: '2026-09-19T12:00:00.000Z',
        },
      ],
    };
    expect(stateLines(state, { now: new Date('2026-09-20T18:00:00.000Z') })).toContain(
      'Deployed: prod (compose, fsn1, deployed yesterday)',
    );
  });

  it('reports N days ago for older deploys', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [
        {
          name: 'prod',
          status: 'deployed',
          deployMode: 'compose',
          region: 'fsn1',
          domain: 'example.com',
          deployedAt: '2026-09-15T12:00:00.000Z',
        },
      ],
    };
    expect(stateLines(state, { now: new Date('2026-09-20T18:00:00.000Z') })).toContain(
      'Deployed: prod (compose, fsn1, example.com, deployed 5 days ago)',
    );
  });

  it('clamps a deployedAt in the future to today rather than a negative day count', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [
        {
          name: 'prod',
          status: 'deployed',
          deployMode: 'compose',
          region: null,
          domain: null,
          deployedAt: '2026-09-23T12:00:00.000Z',
        },
      ],
    };
    expect(stateLines(state, { now: new Date('2026-09-20T18:00:00.000Z') })).toContain(
      'Deployed: prod (compose, deployed today)',
    );
  });

  it('omits the deployed clause entirely when deployedAt cannot be parsed', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [
        {
          name: 'prod',
          status: 'deployed',
          deployMode: 'compose',
          region: 'fsn1',
          domain: null,
          deployedAt: 'not a date',
        },
      ],
    };
    expect(stateLines(state, { now: new Date('2026-09-20T18:00:00.000Z') })).toContain(
      'Deployed: prod (compose, fsn1)',
    );
  });

  it('ignores environments that are not deployed', () => {
    const state = {
      kind: 'project' as const,
      project: { name: 'acme' },
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [
        {
          name: 'stg',
          status: 'deploying',
          deployMode: 'compose',
          region: 'fsn1',
          domain: null,
          deployedAt: null,
        },
      ],
    };
    expect(stateLines(state)).toContain('Deployed: none');
  });
});
