/**
 * Command registry: the one list of vibecarbon commands, in display order.
 *
 * Top-level help and generated docs render from this list plus each
 * command's exported `SPEC` (summary + flags). The registry carries only what
 * a SPEC can't: the display category and the argument hint shown after the
 * name. Loaders use dynamic `import()` so `src/cli.js` startup cost is unchanged.
 */

/** @typedef {import('./parse-flags.js').CommandSpec} CommandSpec */

/**
 * @typedef {object} CommandEntry
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {'dev' | 'deploy' | 'debug' | 'license'} category
 * @property {string} usage - argument hint shown after the name ('' when none)
 * @property {() => Promise<CommandSpec & { summary?: string }>} loadSpec
 */

/** @type {CommandEntry[]} */
export const COMMANDS = [
  // Dev
  {
    name: 'next',
    aliases: ['?'],
    category: 'dev',
    usage: '',
    loadSpec: async () => (await import('../../next.js')).SPEC,
  },
  {
    name: 'create',
    category: 'dev',
    usage: '<project-name>',
    loadSpec: async () => (await import('../../create.js')).SPEC,
  },
  {
    name: 'up',
    category: 'dev',
    usage: '',
    loadSpec: async () => (await import('../../up.js')).SPEC,
  },
  {
    name: 'down',
    category: 'dev',
    usage: '',
    loadSpec: async () => (await import('../../down.js')).SPEC,
  },
  {
    name: 'status',
    category: 'dev',
    usage: '',
    loadSpec: async () => (await import('../../status.js')).SPEC,
  },
  {
    name: 'reset',
    category: 'dev',
    usage: '',
    loadSpec: async () => (await import('../../reset.js')).SPEC,
  },
  {
    name: 'add',
    category: 'dev',
    usage: '[feature]',
    loadSpec: async () => (await import('../../add.js')).buildSpec(),
  },
  {
    name: 'remove',
    category: 'dev',
    usage: '[feature]',
    loadSpec: async () => (await import('../../remove.js')).SPEC,
  },
  {
    name: 'configure',
    category: 'dev',
    usage: '',
    loadSpec: async () => (await import('../../configure.js')).SPEC,
  },
  {
    name: 'upgrade',
    category: 'dev',
    usage: '',
    loadSpec: async () => (await import('../../upgrade.js')).SPEC,
  },
  {
    name: 'telemetry',
    category: 'dev',
    usage: '[on|off]',
    loadSpec: async () => (await import('../../telemetry.js')).SPEC,
  },
  // Deploy
  {
    name: 'deploy',
    category: 'deploy',
    usage: '[env]',
    loadSpec: async () => (await import('../../deploy.js')).SPEC,
  },
  {
    name: 'destroy',
    category: 'deploy',
    usage: '[env]',
    loadSpec: async () => (await import('../../destroy.js')).SPEC,
  },
  {
    name: 'backup',
    category: 'deploy',
    usage: '[env]',
    loadSpec: async () => (await import('../../backup.js')).SPEC,
  },
  {
    name: 'restore',
    category: 'deploy',
    usage: '[env]',
    loadSpec: async () => (await import('../../restore.js')).SPEC,
  },
  {
    name: 'failover',
    category: 'deploy',
    usage: '[env]',
    loadSpec: async () => (await import('../../failover.js')).SPEC,
  },
  {
    name: 'scale',
    category: 'deploy',
    usage: '[env]',
    loadSpec: async () => (await import('../../scale.js')).SPEC,
  },
  // Debug
  {
    name: 'shell',
    category: 'debug',
    usage: '[env]',
    loadSpec: async () => (await import('../../shell.js')).SPEC,
  },
  {
    name: 'diagnose',
    category: 'debug',
    usage: '[env]',
    loadSpec: async () => (await import('../../diagnose.js')).SPEC,
  },
  {
    name: 'console',
    category: 'debug',
    usage: '<node>',
    loadSpec: async () => (await import('../../console.js')).SPEC,
  },
  {
    name: 'access',
    category: 'debug',
    usage: '[subcommand]',
    loadSpec: async () => (await import('../../access.js')).SPEC,
  },
  // License
  {
    name: 'activate',
    category: 'license',
    usage: '[key]',
    loadSpec: async () => (await import('../../activate.js')).ACTIVATE_SPEC,
  },
  {
    name: 'deactivate',
    category: 'license',
    usage: '[key]',
    loadSpec: async () => (await import('../../activate.js')).DEACTIVATE_SPEC,
  },
];

/**
 * Load every command's SPEC, in registry order.
 * @returns {Promise<Array<{ entry: CommandEntry, spec: CommandSpec & { summary?: string } }>>}
 */
export async function loadAllSpecs() {
  return Promise.all(COMMANDS.map(async (entry) => ({ entry, spec: await entry.loadSpec() })));
}
