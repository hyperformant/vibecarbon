import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `vibecarbon ?` / `vibecarbon next`, the interactive loop.
 *
 * src/next.js is the only file in the feature that prints, prompts and maps
 * a child's exit code; everything it decides with lives in the pure
 * src/lib/next/* libraries, which have their own suites. So this suite
 * pins the wiring: which prompt each state opens, what gets launched, and
 * which exit code a child's result becomes.
 */

const clack = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

const detectProjectState = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/next/state.js', () => ({ detectProjectState }));

const launchCli = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/next/launch.js', () => ({ launchCli }));

vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: vi.fn() }));

const getLicense = vi.hoisted(() => vi.fn(() => ({ active: false })));
vi.mock('../../../src/lib/licensing/index.js', () => ({ getLicense }));

const selectAction = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/cli/select-action.js', () => ({ selectAction }));

const selectEnvironment = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/cli/select-environment.js', () => ({ selectEnvironment }));

import { run } from '../../../src/next.js';

const CANCEL = Symbol.for('cancel');
const cwd = process.cwd();
const originalExit = process.exit;
const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  getLicense.mockReturnValue({ active: false });
  setTTY(true);
  process.exit = vi.fn((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
  // Under vitest stdin has no own isTTY, so there is no descriptor to put
  // back and the property setTTY defined has to be removed instead.
  if (originalTTY) Object.defineProperty(process.stdin, 'isTTY', originalTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

const noProject = { kind: 'no-project', cwd };

function env(overrides: Record<string, unknown> = {}) {
  return {
    name: 'prod',
    status: 'deployed',
    deployMode: 'compose',
    region: null,
    domain: null,
    deployedAt: null,
    ...overrides,
  };
}

function projectState(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'project',
    cwd,
    projectConfig: { environments: {} },
    project: { name: 'demo' },
    localDev: { dockerAvailable: true, running: [] },
    configured: { any: false, features: [], providers: false },
    environments: [],
    ...overrides,
  };
}

/** Local dev never started: the ladder is on `up`. */
const upState = projectState();

/** Local dev running, nothing configured: the ladder is on `configure`. */
const configureState = projectState({
  localDev: { dockerAvailable: true, running: ['web'] },
});

/** Configured: the ladder is on `deploy`. */
const deployState = projectState({
  localDev: { dockerAvailable: true, running: ['web'] },
  configured: { any: true, features: ['CI/CD'], providers: false },
});

/** One deployed environment: the ladder is done, the menu takes over. */
const menuState = projectState({
  projectConfig: { environments: { prod: { status: 'deployed' } } },
  localDev: { dockerAvailable: true, running: ['web'] },
  configured: { any: true, features: ['CI/CD'], providers: false },
  environments: [env()],
});

/** Two deployed environments: an env-scoped action has to ask which one. */
const twoEnvMenuState = projectState({
  projectConfig: {
    environments: { prod: { status: 'deployed' }, staging: { status: 'deployed' } },
  },
  localDev: { dockerAvailable: true, running: ['web'] },
  configured: { any: true, features: ['CI/CD'], providers: false },
  environments: [env(), env({ name: 'staging' })],
});

/** Note bodies are coloured the same way help examples are. */
function noteText(call: unknown[]) {
  return stripVTControlCharacters(String(call[0]));
}

describe('up step', () => {
  it('launches up and exits with the child code when confirmed', async () => {
    detectProjectState.mockResolvedValue(upState);
    clack.confirm.mockResolvedValue(true);
    launchCli.mockResolvedValue({ code: 0, signal: null });

    await expect(run([])).rejects.toThrow('process.exit:0');
    expect(launchCli).toHaveBeenCalledWith(['up'], { cwd });
  });

  it('never resumes the loop after up: one state read, one launch', async () => {
    detectProjectState.mockResolvedValue(upState);
    clack.confirm.mockResolvedValue(true);
    launchCli.mockResolvedValue({ code: 0, signal: null });

    await expect(run([])).rejects.toThrow('process.exit:0');
    expect(detectProjectState).toHaveBeenCalledTimes(1);
    expect(launchCli).toHaveBeenCalledTimes(1);
  });

  it('declining prints the command and returns without launching or exiting', async () => {
    detectProjectState.mockResolvedValue(upState);
    clack.confirm.mockResolvedValue(false);

    await expect(run([])).resolves.toBeUndefined();
    expect(launchCli).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    expect(clack.outro).toHaveBeenCalledWith("When you're ready: vibecarbon up");
  });

  it('cancelling the confirm exits 130', async () => {
    detectProjectState.mockResolvedValue(upState);
    clack.confirm.mockResolvedValue(CANCEL);

    await expect(run([])).rejects.toThrow('process.exit:130');
    expect(launchCli).not.toHaveBeenCalled();
  });

  it('maps a failing child to its own exit code', async () => {
    detectProjectState.mockResolvedValue(upState);
    clack.confirm.mockResolvedValue(true);
    launchCli.mockResolvedValue({ code: 2, signal: null });

    await expect(run([])).rejects.toThrow('process.exit:2');
  });

  it('maps a SIGINT-killed child to 130', async () => {
    detectProjectState.mockResolvedValue(upState);
    clack.confirm.mockResolvedValue(true);
    launchCli.mockResolvedValue({ code: null, signal: 'SIGINT' });

    await expect(run([])).rejects.toThrow('process.exit:130');
  });
});

describe('without a terminal', () => {
  it('prints the step and returns without asking anything', async () => {
    setTTY(false);
    detectProjectState.mockResolvedValue(upState);

    await expect(run([])).resolves.toBeUndefined();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    expect(launchCli).not.toHaveBeenCalled();
    expect(noteText(clack.note.mock.calls[0])).toContain('vibecarbon up');
    expect(clack.outro).toHaveBeenCalledWith(
      'Run vibecarbon ? in a terminal to do this interactively.',
    );
  });

  it('prints the deployed menu without asking anything', async () => {
    setTTY(false);
    detectProjectState.mockResolvedValue(menuState);

    await expect(run([])).resolves.toBeUndefined();
    expect(clack.select).not.toHaveBeenCalled();
    expect(noteText(clack.note.mock.calls[0])).toContain('vibecarbon scale prod');
  });
});

describe('below the project root', () => {
  const subdir = `${cwd}/src/client`;

  it('shows the project step and stops at the cd instead of launching', async () => {
    detectProjectState.mockResolvedValue(projectState({ subdir }));

    await expect(run([])).resolves.toBeUndefined();
    // Every command asserts the project root as its cwd, and this process
    // cannot cd the user's shell, so the guide hands over the cd instead.
    expect(launchCli).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    const notes = clack.note.mock.calls.map((call) => noteText(call));
    expect(notes[0]).toContain('vibecarbon up');
    expect(notes[1]).toContain(`cd ${cwd}`);
  });

  it('shows the deployed menu without opening the select', async () => {
    detectProjectState.mockResolvedValue({ ...menuState, subdir });

    await expect(run([])).resolves.toBeUndefined();
    expect(clack.select).not.toHaveBeenCalled();
    expect(launchCli).not.toHaveBeenCalled();
    expect(noteText(clack.note.mock.calls[0])).toContain('vibecarbon scale prod');
  });
});

describe('create step', () => {
  it('launches create bare and leaves the name prompt and the cd note to it', async () => {
    detectProjectState.mockResolvedValue(noProject);
    clack.confirm.mockResolvedValue(true);
    launchCli.mockResolvedValue({ code: 0, signal: null });

    await expect(run([])).resolves.toBeUndefined();
    // create prompts for the name whenever the argument is absent, and ends
    // with its own "Next steps" note leading with `cd <name>`. The guide
    // asking first would put that question ahead of create's banner and
    // print a second note repeating the same cd. Nothing needs to cross the
    // process boundary: the ladder re-derives from the cwd every run, so
    // this directory still resolves to "create".
    expect(launchCli).toHaveBeenCalledWith(['create'], { cwd });
    expect(clack.text).not.toHaveBeenCalled();
    // Only the "Next: Create a project" step block, nothing after the child.
    expect(clack.note).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('declining returns without launching', async () => {
    detectProjectState.mockResolvedValue(noProject);
    clack.confirm.mockResolvedValue(false);

    await expect(run([])).resolves.toBeUndefined();
    expect(launchCli).not.toHaveBeenCalled();
    expect(clack.outro).toHaveBeenCalledWith("When you're ready: vibecarbon create <project-name>");
  });
});

describe('configure step', () => {
  it('skipping configure offers deploy on the next pass', async () => {
    detectProjectState.mockResolvedValue(configureState);
    selectAction.mockResolvedValue('skip');
    clack.confirm.mockResolvedValue(false);

    await expect(run([])).resolves.toBeUndefined();
    expect(clack.confirm).toHaveBeenCalledWith({ message: 'Deploy now?' });
    expect(launchCli).not.toHaveBeenCalled();
  });

  it('running configure re-reads the state afterwards', async () => {
    detectProjectState.mockResolvedValue(configureState);
    selectAction.mockResolvedValueOnce('configure').mockResolvedValueOnce('nothing');
    launchCli.mockResolvedValue({ code: 0, signal: null });

    await expect(run([])).resolves.toBeUndefined();
    expect(launchCli).toHaveBeenCalledWith(['configure'], { cwd });
    expect(detectProjectState).toHaveBeenCalledTimes(2);
  });

  it('choosing nothing returns with the command in the outro', async () => {
    detectProjectState.mockResolvedValue(configureState);
    selectAction.mockResolvedValue('nothing');

    await expect(run([])).resolves.toBeUndefined();
    expect(clack.outro).toHaveBeenCalledWith("When you're ready: vibecarbon configure");
  });
});

describe('deploy step', () => {
  it('mentions activation when the project has no license', async () => {
    detectProjectState.mockResolvedValue(deployState);
    clack.confirm.mockResolvedValue(false);

    await expect(run([])).resolves.toBeUndefined();
    const logged = clack.log.info.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('vibecarbon activate <key>');
  });

  it('stays quiet about activation when a license is active', async () => {
    getLicense.mockReturnValue({ active: true });
    detectProjectState.mockResolvedValue(deployState);
    clack.confirm.mockResolvedValue(false);

    await expect(run([])).resolves.toBeUndefined();
    const logged = clack.log.info.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('vibecarbon activate');
  });

  it('launches deploy when confirmed', async () => {
    detectProjectState.mockResolvedValueOnce(deployState).mockResolvedValueOnce(menuState);
    clack.confirm.mockResolvedValue(true);
    clack.select.mockResolvedValue('nothing');
    launchCli.mockResolvedValue({ code: 0, signal: null });

    await expect(run([])).resolves.toBeUndefined();
    expect(launchCli).toHaveBeenCalledWith(['deploy'], { cwd });
  });
});

describe('deployed menu', () => {
  it('runs an env-scoped action against the only deployed environment', async () => {
    detectProjectState.mockResolvedValue(menuState);
    clack.select.mockResolvedValueOnce('scale').mockResolvedValueOnce('nothing');
    clack.confirm.mockResolvedValue(true);
    launchCli.mockResolvedValue({ code: 0, signal: null });

    await expect(run([])).resolves.toBeUndefined();
    expect(launchCli).toHaveBeenCalledWith(['scale', 'prod'], { cwd });
  });

  it('asks which environment when more than one is deployed', async () => {
    detectProjectState.mockResolvedValue(twoEnvMenuState);
    clack.select.mockResolvedValueOnce('scale').mockResolvedValueOnce('nothing');
    selectEnvironment.mockResolvedValue({ envName: 'staging' });
    clack.confirm.mockResolvedValue(true);
    launchCli.mockResolvedValue({ code: 0, signal: null });

    await expect(run([])).resolves.toBeUndefined();
    expect(selectEnvironment).toHaveBeenCalledTimes(1);
    expect(selectEnvironment.mock.calls[0][0]).toEqual({
      environments: { prod: { status: 'deployed' }, staging: { status: 'deployed' } },
    });
    expect(launchCli).toHaveBeenCalledWith(['scale', 'staging'], { cwd });
  });

  it('declining the confirm prints the command and returns', async () => {
    detectProjectState.mockResolvedValue(menuState);
    clack.select.mockResolvedValue('status');
    clack.confirm.mockResolvedValue(false);

    await expect(run([])).resolves.toBeUndefined();
    expect(launchCli).not.toHaveBeenCalled();
    expect(clack.outro).toHaveBeenCalledWith("When you're ready: vibecarbon status");
  });

  it('asks for a name when the action needs one', async () => {
    detectProjectState.mockResolvedValue(menuState);
    clack.select.mockResolvedValue('deploy-another');
    clack.text.mockResolvedValue('staging');
    clack.confirm.mockResolvedValue(false);

    await expect(run([])).resolves.toBeUndefined();
    expect(clack.outro).toHaveBeenCalledWith("When you're ready: vibecarbon deploy staging");
  });

  it('choosing nothing says goodbye without launching', async () => {
    detectProjectState.mockResolvedValue(menuState);
    clack.select.mockResolvedValue('nothing');

    await expect(run([])).resolves.toBeUndefined();
    expect(launchCli).not.toHaveBeenCalled();
    expect(clack.outro).toHaveBeenCalledWith('See you next time.');
  });

  it('cancelling the menu exits 130', async () => {
    detectProjectState.mockResolvedValue(menuState);
    clack.select.mockResolvedValue(CANCEL);

    await expect(run([])).rejects.toThrow('process.exit:130');
  });
});

describe('-h', () => {
  it('prints help and never reads the project state', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(run(['-h'])).resolves.toBeUndefined();
      expect(stripVTControlCharacters(String(write.mock.calls[0][0]))).toContain('vibecarbon next');
    } finally {
      write.mockRestore();
    }
    expect(detectProjectState).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
  });
});
