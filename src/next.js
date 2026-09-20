/**
 * Vibecarbon Next Command (`vibecarbon ?` / `vibecarbon next`)
 *
 * The "what do I do now" guide. It reads where the project stands, names
 * the next step on the create, up, configure, deploy ladder, shows the
 * exact command, and offers to run it. Once an environment is deployed the
 * ladder is finished and the same command becomes a menu of everyday
 * operations.
 *
 * This file is the ONLY part of the feature that prints, prompts, launches
 * a child, or maps an exit code. Everything it decides with lives in the
 * pure libraries under src/lib/next/ (state, steps, render, launch), which
 * is what keeps the guide unit-testable without a terminal or Docker.
 *
 * Three rules the loop depends on: a step with no command (the deployed
 * menu) never reaches stepBlock, so the menu branch is taken first; `up`
 * blocks the terminal until the operator stops it, so the run ends with the
 * child's exit code instead of looping back; and declining is never a
 * failure, so a "no" at any confirm prints the command and returns 0.
 */

import * as p from '@clack/prompts';
import { CANCELLED_EXIT_CODE, exitCancelled } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { selectAction } from './lib/cli/select-action.js';
import { selectEnvironment } from './lib/cli/select-environment.js';
import { c } from './lib/colors.js';
import { getLicense } from './lib/licensing/index.js';
import { launchCli } from './lib/next/launch.js';
import { displayCommand, menuLines, stateLines, stepBlock } from './lib/next/render.js';
import { detectProjectState } from './lib/next/state.js';
import { deployedEnvironments, deployedMenu, nextStep } from './lib/next/steps.js';
import { validateProjectName } from './lib/validators.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
export const SPEC = {
  name: 'next',
  summary: 'Show what to do next and offer to run it',
  description: [
    'Looks at the current directory, says where you are in the create, up, configure, deploy',
    'ladder, shows the exact command for the next step and offers to run it for you.',
    'Once an environment is deployed it becomes a menu of everyday operations.',
    '',
    'SPELLINGS',
    "  vibecarbon ?      Short form. zsh needs quotes: vibecarbon '?'",
    '  vibecarbon next   Same command, safe in every shell and in scripts',
    '',
    'Without a terminal (CI, pipes, agents) it prints the next command and exits 0 without asking.',
  ].join('\n'),
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
  ],
  examples: [
    { command: 'vibecarbon ?', description: 'What should I do next?' },
    { command: 'vibecarbon next', description: 'Same, spelled out' },
  ],
};

const OFF_TTY_OUTRO = 'Run vibecarbon ? in a terminal to do this interactively.';

/**
 * A child's close result as an exit code for this process. A child stopped
 * by Ctrl-C is a cancel, not a failure of the guide.
 *
 * @param {{ code: number|null, signal: string|null }} result
 * @returns {number}
 */
function exitCodeFor({ code, signal }) {
  return signal === 'SIGINT' || code === 130 ? CANCELLED_EXIT_CODE : (code ?? 1);
}

/**
 * Keep going only while the child succeeded. A failed step must not be
 * followed by a cheerful "what next", and its exit code is the run's.
 *
 * @param {{ code: number|null, signal: string|null }} result
 * @returns {void}
 */
function exitFromChild(result) {
  if (result.code === 0) return;
  process.exit(exitCodeFor(result));
}

/**
 * argv for a chosen menu item, prompting for an environment or a new
 * environment name when the item needs one.
 *
 * @param {import('./lib/next/steps.js').MenuItem} item
 * @param {object} state
 * @param {Array<{ name: string }>} deployed
 * @returns {Promise<string[]>}
 */
async function menuArgv(item, state, deployed) {
  if (item.envScoped) {
    if (deployed.length === 1) return [...item.command, deployed[0].name];
    const { envName } = await selectEnvironment(
      {
        environments: Object.fromEntries(
          deployed.map((e) => [e.name, state.projectConfig.environments[e.name]]),
        ),
      },
      { actionVerb: item.label.toLowerCase() },
    );
    return [...item.command, envName];
  }

  if (item.needsName) {
    const name = await p.text({
      message: 'Environment name?',
      validate: (value) =>
        /^[a-z][a-z0-9-]{0,30}$/.test(value)
          ? undefined
          : 'lowercase letters, digits and hyphens, starting with a letter',
    });
    if (p.isCancel(name)) exitCancelled();
    return [item.command[0], name];
  }

  return item.command;
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
export async function run(args) {
  const { handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  const cwd = process.cwd();
  // Checked once: every prompt below is reachable only when this is true.
  const interactive = Boolean(process.stdin.isTTY);

  introCommand('?');

  let skipConfigure = false;

  for (;;) {
    const state = await detectProjectState(cwd);
    // One call: each p.log.info draws its own gutter dot.
    p.log.info(stateLines(state).join('\n'));

    const step = nextStep(state, { skipConfigure });

    if (step.id === 'menu') {
      const items = deployedMenu(state);
      const deployed = deployedEnvironments(state);

      if (!interactive) {
        p.note(menuLines(items, { envName: deployed[0].name }).join('\n'), 'What next');
        p.outro(OFF_TTY_OUTRO);
        return;
      }

      const choice = await p.select({
        message: 'What next?',
        options: items.map(({ value, label, hint }) => ({ value, label, hint })),
      });
      if (p.isCancel(choice)) exitCancelled();
      if (choice === 'nothing') {
        p.outro('See you next time.');
        return;
      }

      const item = items.find((entry) => entry.value === choice);
      const argv = await menuArgv(item, state, deployed);
      const display = displayCommand(argv);
      p.note(menuLines([{ ...item, command: argv, envScoped: false }]).join('\n'), 'Command');

      const ok = await p.confirm({ message: 'Run it now?' });
      if (p.isCancel(ok)) exitCancelled();
      if (!ok) {
        p.outro(`When you're ready: ${display}`);
        return;
      }

      exitFromChild(await launchCli(argv, { cwd }));
      continue;
    }

    p.note(stepBlock(step).join('\n'), `Next: ${step.title}`);

    if (!interactive) {
      p.outro(OFF_TTY_OUTRO);
      return;
    }

    if (step.id === 'create') {
      const ok = await p.confirm({ message: 'Would you like to create one now?' });
      if (p.isCancel(ok)) exitCancelled();
      if (!ok) {
        p.outro("When you're ready: vibecarbon create <name>");
        return;
      }
      const name = await p.text({
        message: 'Project name?',
        placeholder: 'my-app',
        validate: validateProjectName,
      });
      if (p.isCancel(name)) exitCancelled();
      exitFromChild(await launchCli(['create', name], { cwd }));
      p.note(`cd ${name}\nvibecarbon ?`, 'Next');
      p.outro('The guide cannot change your shell directory, so cd first.');
      return;
    }

    if (step.id === 'up') {
      const ok = await p.confirm({ message: 'Start it now?' });
      if (p.isCancel(ok)) exitCancelled();
      if (!ok) {
        p.outro("When you're ready: vibecarbon up");
        return;
      }
      p.log.info(
        'up keeps running until you press Ctrl-C. When you are done, run vibecarbon ? again for the next step.',
      );
      // Terminal-blocking: the run ends with up's own exit code.
      process.exit(exitCodeFor(await launchCli(['up'], { cwd })));
    }

    if (step.id === 'configure') {
      const choice = await selectAction({
        message: 'What next?',
        choices: [
          { value: 'configure', label: 'Configure services now', hint: 'vibecarbon configure' },
          { value: 'skip', label: 'Skip to deploy' },
          { value: 'nothing', label: 'Nothing right now' },
        ],
      });
      if (choice === 'configure') {
        exitFromChild(await launchCli(['configure'], { cwd }));
        continue;
      }
      if (choice === 'skip') {
        skipConfigure = true;
        continue;
      }
      p.outro("When you're ready: vibecarbon configure");
      return;
    }

    if (!getLicense({ projectDir: cwd }).active) {
      p.log.info(c.dim('Kubernetes and HA modes need a license: vibecarbon activate <key>'));
    }
    const ok = await p.confirm({ message: 'Deploy now?' });
    if (p.isCancel(ok)) exitCancelled();
    if (!ok) {
      p.outro("When you're ready: vibecarbon deploy");
      return;
    }
    // A finished deploy lands on the menu on the next pass.
    exitFromChild(await launchCli(['deploy'], { cwd }));
  }
}
