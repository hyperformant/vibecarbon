/**
 * Ladder step selection and the deployed-environment menu for `vibecarbon ?`
 * ("what's next" guide).
 *
 * Pure library: no clack, no colors, no printing, no process.exit. This
 * module only decides WHICH step or menu items apply to a given state.
 * src/next.js is the only place that turns the result into terminal output.
 */

/** The opinionated path a fresh project climbs before it is deployed. */
export const LADDER = ['create', 'up', 'configure', 'deploy'];

/**
 * @param {object} state
 * @returns {Array<object>} environments whose status === 'deployed'
 */
export function deployedEnvironments(state) {
  return (state.environments ?? []).filter((env) => env.status === 'deployed');
}

/**
 * @typedef {{
 *   id: 'create'|'up'|'configure'|'deploy'|'menu',
 *   title: string,
 *   why: string,
 *   command: string[]|null,
 *   display: string|null,
 *   canLaunch: boolean,
 *   blocksTerminal: boolean,
 *   optional: boolean,
 * }} Step
 */

/**
 * @param {object} fields
 * @returns {Step}
 */
function makeStep({ id, title, why, command, blocksTerminal = false, optional = false }) {
  return {
    id,
    title,
    why,
    command,
    display: command ? ['vibecarbon', ...command].join(' ') : null,
    canLaunch: command !== null,
    blocksTerminal,
    optional,
  };
}

/**
 * @param {object} state
 * @param {{ skipConfigure?: boolean }} [options]
 * @returns {Step}
 */
export function nextStep(state, { skipConfigure = false } = {}) {
  if (state.kind === 'no-project') {
    return makeStep({
      id: 'create',
      title: 'Create a project',
      why: 'Scaffolds a new app with a local Supabase stack. You will pick a name and an admin login.',
      command: ['create', '<name>'],
    });
  }

  if (deployedEnvironments(state).length > 0) {
    return makeStep({
      id: 'menu',
      title: 'You are deployed',
      why: 'Opinionated setup ends here. Pick what you want to do next.',
      command: null,
    });
  }

  const { localDev, configured } = state;
  const upDone = localDev.running.length > 0 || configured.any;
  const configureDone = configured.any || skipConfigure;

  if (!upDone) {
    let why = 'Starts the Docker services and the dev server so you can build and test locally.';
    if (!localDev.dockerAvailable) {
      why += ' Docker does not seem to be running; up will tell you what it needs.';
    }
    return makeStep({
      id: 'up',
      title: 'Start local development',
      why,
      command: ['up'],
      blocksTerminal: true,
    });
  }

  if (!configureDone) {
    return makeStep({
      id: 'configure',
      title: 'Configure services (optional)',
      why: 'Sets up cloud provider credentials, payments, OAuth, SMTP and CI/CD before your first deploy. Deploy works without it.',
      command: ['configure'],
      optional: true,
    });
  }

  let why =
    'Provisions a server or cluster and ships the app. Single-server Compose is free; Kubernetes and HA modes need a license.';
  const resuming = (state.environments ?? []).find((env) => env.status === 'deploying');
  if (resuming) {
    why += ` A previous deploy of ${resuming.name} did not finish; running deploy again resumes it.`;
  }
  return makeStep({
    id: 'deploy',
    title: 'Deploy to the cloud',
    why,
    command: ['deploy'],
  });
}

/**
 * @typedef {{
 *   value: string,
 *   label: string,
 *   hint?: string,
 *   command: string[]|null,
 *   envScoped: boolean,
 *   needsName?: boolean,
 * }} MenuItem
 */

/**
 * The actions available once a project has at least one deployed
 * environment. Static regardless of state today; takes `state` so a future
 * rule (e.g. hiding `failover` outside HA modes) can filter without
 * changing the signature.
 *
 * @param {object} _state
 * @returns {MenuItem[]}
 */
export function deployedMenu(_state) {
  return [
    { value: 'status', label: 'Check status', command: ['status'], envScoped: false },
    { value: 'scale', label: 'Scale an environment', command: ['scale'], envScoped: true },
    { value: 'backup', label: 'Back up the database', command: ['backup'], envScoped: true },
    { value: 'restore', label: 'Restore the database', command: ['restore'], envScoped: true },
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
      command: ['shell'],
      envScoped: true,
    },
    {
      value: 'diagnose',
      label: 'Dump cluster diagnostics',
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
      hint: 'Destructive',
      command: ['destroy'],
      envScoped: true,
    },
    { value: 'nothing', label: 'Nothing right now', command: null, envScoped: false },
  ];
}
