import { describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from '../../../../src/cli.js';
import {
  deployedEnvironments,
  deployedMenu,
  LADDER,
  nextStep,
} from '../../../../src/lib/next/steps.js';

type Env = {
  name: string;
  status: string | null;
  deployMode: string | null;
  region: string | null;
  domain: string | null;
  deployedAt: string | null;
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    name: 'prod',
    status: 'deployed',
    deployMode: 'compose',
    region: 'fsn1',
    domain: 'example.com',
    deployedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

function projectState(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'project' as const,
    cwd: '/tmp/acme',
    projectConfig: {},
    project: { name: 'acme' },
    localDev: { dockerAvailable: true, running: [] as string[] },
    configured: { any: false, features: [] as string[], providers: false },
    environments: [] as Env[],
    ...overrides,
  };
}

describe('LADDER', () => {
  it('lists the opinionated path in order', () => {
    expect(LADDER).toEqual(['create', 'up', 'configure', 'deploy']);
  });
});

describe('deployedEnvironments', () => {
  it('returns only environments whose status is deployed', () => {
    const state = projectState({
      environments: [
        env({ name: 'prod', status: 'deployed' }),
        env({ name: 'stg', status: 'deploying' }),
      ],
    });
    expect(deployedEnvironments(state)).toEqual([env({ name: 'prod', status: 'deployed' })]);
  });

  it('returns an empty array when there are no environments', () => {
    expect(deployedEnvironments(projectState())).toEqual([]);
  });
});

describe('nextStep', () => {
  it('rule 1: no-project state returns the create step', () => {
    const step = nextStep({ kind: 'no-project', cwd: '/tmp/empty' });
    expect(step).toEqual({
      id: 'create',
      title: 'Create a project',
      why: 'Every project lives in its own folder with its own git repo and dev stack.',
      command: ['create', '<project-name>'],
      display: 'vibecarbon create <project-name>',
      canLaunch: true,
      blocksTerminal: false,
      optional: false,
    });
  });

  it('rule 2: a deployed environment returns the menu step regardless of other fields', () => {
    const state = projectState({
      localDev: { dockerAvailable: false, running: [] },
      configured: { any: false, features: [], providers: false },
      environments: [env({ status: 'deployed' })],
    });
    const step = nextStep(state);
    expect(step).toEqual({
      id: 'menu',
      title: 'You are deployed',
      why: "You're past the setup phase. Pick what you want to do next.",
      command: null,
      display: null,
      canLaunch: false,
      blocksTerminal: false,
      optional: false,
    });
  });

  it('rule 4: nothing done yet returns the up step', () => {
    const state = projectState({ localDev: { dockerAvailable: true, running: [] } });
    const step = nextStep(state);
    expect(step).toEqual({
      id: 'up',
      title: 'Start local development',
      why: "Let's spin up your dev environment. Docker and your app will be ready to build and test.",
      command: ['up'],
      display: 'vibecarbon up',
      canLaunch: true,
      blocksTerminal: true,
      optional: false,
    });
  });

  it('rule 4: docker unavailable appends the Docker sentence to the up step', () => {
    const state = projectState({ localDev: { dockerAvailable: false, running: [] } });
    const step = nextStep(state);
    expect(step.id).toBe('up');
    expect(step.why).toBe(
      "Let's spin up your dev environment. Docker and your app will be ready to build and test. " +
        "Docker doesn't seem to be running yet; up will tell you what it needs.",
    );
  });

  it('rule 5: local dev running but not configured returns the configure step', () => {
    const state = projectState({
      localDev: { dockerAvailable: true, running: ['web', 'db'] },
      configured: { any: false, features: [], providers: false },
    });
    const step = nextStep(state);
    expect(step).toEqual({
      id: 'configure',
      title: 'Configure services (optional)',
      why: 'Enter cloud credentials, payments, OAuth, SMTP and CI/CD details before your first deploy. Deploy works without it.',
      command: ['configure'],
      display: 'vibecarbon configure',
      canLaunch: true,
      blocksTerminal: false,
      optional: true,
    });
  });

  it('rule 6: running + skipConfigure returns the deploy step', () => {
    const state = projectState({
      localDev: { dockerAvailable: true, running: ['web'] },
      configured: { any: false, features: [], providers: false },
    });
    const step = nextStep(state, { skipConfigure: true });
    expect(step).toEqual({
      id: 'deploy',
      title: 'Deploy to the cloud',
      why: 'Provisions a server or cluster on your cloud account and ships the app. Compose deploys need no license; Kubernetes and HA modes do.',
      command: ['deploy'],
      display: 'vibecarbon deploy',
      canLaunch: true,
      blocksTerminal: false,
      optional: false,
    });
  });

  it('rule 6: configured but not running returns the deploy step', () => {
    const state = projectState({
      localDev: { dockerAvailable: true, running: [] },
      configured: { any: true, features: ['CI/CD'], providers: false },
    });
    const step = nextStep(state);
    expect(step.id).toBe('deploy');
    expect(step.why).toBe(
      'Provisions a server or cluster on your cloud account and ships the app. Compose deploys need no license; Kubernetes and HA modes do.',
    );
  });

  it('rule 6: a deploying environment appends the resume sentence to the deploy step', () => {
    const state = projectState({
      localDev: { dockerAvailable: true, running: ['web'] },
      configured: { any: true, features: ['CI/CD'], providers: false },
      environments: [env({ name: 'stg', status: 'deploying' })],
    });
    const step = nextStep(state);
    expect(step.id).toBe('deploy');
    expect(step.why).toBe(
      'Provisions a server or cluster on your cloud account and ships the app. Compose deploys need no license; Kubernetes and HA modes do. ' +
        "A previous deploy of stg didn't finish; running deploy again will resume it.",
    );
  });
});

describe('deployedMenu', () => {
  const items = deployedMenu(projectState({ environments: [env({ status: 'deployed' })] }));

  it('pins the menu order, values, labels, hints, commands and flags', () => {
    expect(items).toEqual([
      {
        value: 'status',
        label: 'Check status',
        hint: 'view your deployment',
        command: ['status'],
        envScoped: false,
      },
      { value: 'scale', label: 'Scale an environment', command: ['scale'], envScoped: true },
      {
        value: 'backup',
        label: 'Back up the database',
        hint: 'or list existing backups',
        command: ['backup'],
        envScoped: true,
      },
      {
        value: 'restore',
        label: 'Restore the database',
        hint: 'from a backup',
        command: ['restore'],
        envScoped: true,
      },
      {
        value: 'failover',
        label: 'Fail over to the standby region',
        hint: 'HA deployments only',
        command: ['failover'],
        envScoped: true,
      },
      { value: 'configure', label: 'Configure services', command: ['configure'], envScoped: false },
      {
        value: 'add',
        label: 'Add a feature',
        hint: 'observability, redis',
        command: ['add'],
        envScoped: false,
      },
      { value: 'remove', label: 'Remove a feature', command: ['remove'], envScoped: false },
      { value: 'upgrade', label: 'Upgrade template files', command: ['upgrade'], envScoped: false },
      {
        value: 'shell',
        label: 'Open a shell with cluster credentials',
        hint: 'kubectl and SSH ready',
        command: ['shell'],
        envScoped: true,
      },
      {
        value: 'diagnose',
        label: 'Dump cluster diagnostics',
        hint: 'troubleshoot issues',
        command: ['diagnose'],
        envScoped: true,
      },
      { value: 'access', label: 'Manage operator access', command: ['access'], envScoped: false },
      {
        value: 'deploy-another',
        label: 'Deploy another environment',
        command: ['deploy', '<name>'],
        envScoped: false,
        needsName: true,
      },
      {
        value: 'destroy',
        label: 'Tear down an environment',
        hint: 'destructive',
        command: ['destroy'],
        envScoped: true,
      },
      { value: 'nothing', label: 'Nothing right now', command: null, envScoped: false },
    ]);
  });
});

describe('command census', () => {
  function assertKnown(command: string[] | null) {
    if (!command) return;
    expect(KNOWN_COMMANDS).toContain(command[0]);
  }

  it('every nextStep command[0] across all states is a known CLI command', () => {
    const states = [
      { kind: 'no-project' as const, cwd: '/tmp/empty' },
      projectState({ localDev: { dockerAvailable: true, running: [] } }),
      projectState({ localDev: { dockerAvailable: false, running: [] } }),
      projectState({ localDev: { dockerAvailable: true, running: ['web'] } }),
      projectState({
        localDev: { dockerAvailable: true, running: ['web'] },
        configured: { any: true, features: ['CI/CD'], providers: false },
      }),
      projectState({ environments: [env({ status: 'deployed' })] }),
    ];
    for (const state of states) {
      assertKnown(nextStep(state).command);
      assertKnown(nextStep(state, { skipConfigure: true }).command);
    }
  });

  it('every deployedMenu command[0] is a known CLI command', () => {
    for (const item of deployedMenu(
      projectState({ environments: [env({ status: 'deployed' })] }),
    )) {
      assertKnown(item.command);
    }
  });
});
