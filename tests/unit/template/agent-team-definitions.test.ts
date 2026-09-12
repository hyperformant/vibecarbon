/**
 * The template ships an agent team: `carbon/.claude/settings.json` turns agent
 * teams on and registers two quality-gate hooks, `carbon/.claude/hooks/*.sh`
 * implement them, and `carbon/AGENTS.md` documents a lead-coordinator plus four
 * specialists. Before this guard existed, the definitions themselves lived only
 * in the CLI repo's own `.claude/agents/` — which `package.json` `files`
 * (`src`, `carbon`, `services`) does not publish — so an installed vibecarbon
 * generated projects with hooks and docs for a team that was not on disk.
 *
 * These assertions pin the three ways that can regress:
 *   1. a definition file goes missing (or an extra, CLI-only one ships),
 *   2. a body drifts back to CLI-repo vocabulary (`carbon/` as a template dir,
 *      `{{PLACEHOLDER}}`, `tests/e2e`, pnpm) that is meaningless in an app,
 *   3. the roster stops matching what create.js and AGENTS.md promise.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const AGENTS_DIR = join(REPO_ROOT, 'carbon', '.claude', 'agents');

/** The team the hooks gate and AGENTS.md documents. Nothing else may ship. */
const EXPECTED_AGENTS = [
  'backend-engineer',
  'frontend-engineer',
  'lead-coordinator',
  'security-reviewer',
  'test-maintainer',
];

function read(name: string): string {
  return readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf-8');
}

describe('carbon/.claude/agents', () => {
  it('ships exactly the documented team', () => {
    const files = readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual(EXPECTED_AGENTS);
  });

  it('does not ship the CLI-repo-only e2e-perf-optimizer', () => {
    // It reads tests/results/e2e.db from the real-infra matrix — a generated
    // app has neither the db nor the tier.
    const files = readdirSync(AGENTS_DIR);
    expect(files).not.toContain('e2e-perf-optimizer.md');
  });

  it.each(EXPECTED_AGENTS)('%s has frontmatter whose name matches its filename', (agent) => {
    const content = read(agent);
    expect(content.startsWith('---\n'), `${agent}.md does not open with frontmatter`).toBe(true);

    const end = content.indexOf('\n---\n', 3);
    expect(end, `${agent}.md frontmatter is unterminated`).toBeGreaterThan(0);
    const frontmatter = content.slice(4, end);

    expect(frontmatter).toMatch(new RegExp(`^name: ${agent}$`, 'm'));
    // Claude Code needs these to render the agent in the picker.
    expect(frontmatter, `${agent}.md is missing description:`).toMatch(/^description: /m);
    expect(frontmatter, `${agent}.md is missing model:`).toMatch(/^model: /m);
    expect(frontmatter, `${agent}.md is missing color:`).toMatch(/^color: /m);
  });

  it.each(EXPECTED_AGENTS)('%s carries no CLI-repo-only references', (agent) => {
    const content = read(agent);
    const forbidden: [RegExp, string][] = [
      [/carbon\//, '`carbon/` — the generated project IS the app, not the template dir'],
      [/\{\{[A-Z_]+\}\}/, 'a generation-time {{PLACEHOLDER}} — already substituted by then'],
      [/tests\/e2e|test:e2e/, 'the real-infra e2e tier, which generated projects do not have'],
      [/tests\/smoke|test:smoke/, 'the smoke tier, which generated projects do not have'],
      [/Vibecarbon CLI/, 'the CLI repo — a generated project is an app'],
    ];
    for (const [pattern, why] of forbidden) {
      expect(pattern.test(content), `${agent}.md mentions ${why}`).toBe(false);
    }
  });

  it.each(EXPECTED_AGENTS)('%s names npm, never the CLI repo pnpm', (agent) => {
    // Generated projects default to npm (root uses pnpm; decision 2026-07-30),
    // and .claude/hooks/*.sh run `npm run lint` / `npm test` verbatim. An agent
    // told to run `pnpm lint` hits a command the project may not have.
    expect(read(agent)).not.toMatch(/\bpnpm\b/);
  });

  it('states the quality gates the shipped hooks actually run', () => {
    const idleGate = readFileSync(
      join(REPO_ROOT, 'carbon', '.claude', 'hooks', 'teammate-idle-gate.sh'),
      'utf-8',
    );
    const taskGate = readFileSync(
      join(REPO_ROOT, 'carbon', '.claude', 'hooks', 'task-completed-gate.sh'),
      'utf-8',
    );

    // teammate-idle-gate gates backend + frontend on lint/typecheck/test:security
    for (const agent of ['backend-engineer', 'frontend-engineer']) {
      expect(idleGate).toContain(agent);
      const body = read(agent);
      expect(body, `${agent}.md does not mention the lint gate`).toContain('npm run lint');
      expect(body, `${agent}.md does not mention the typecheck gate`).toContain(
        'npm run typecheck',
      );
      expect(body, `${agent}.md does not mention the security gate`).toContain(
        'npm run test:security',
      );
    }

    // task-completed-gate gates test-maintainer on the full `npm test`
    expect(taskGate).toContain('test-maintainer');
    expect(taskGate).toMatch(/^if ! npm test /m);
    expect(read('test-maintainer')).toContain('a hook runs `npm test`');
  });

  it('carries no auto-injected Persistent Agent Memory footer', () => {
    // Claude Code re-injects that section at runtime from the `memory:`
    // frontmatter field; a copy baked into the file ships stale duplicate text.
    for (const agent of EXPECTED_AGENTS) {
      expect(read(agent), `${agent}.md has a baked-in memory footer`).not.toContain(
        '\n# Persistent Agent Memory',
      );
    }
  });

  it('matches the roster create.js seeds agent-memory directories for', () => {
    const createJs = readFileSync(join(REPO_ROOT, 'src', 'create.js'), 'utf-8');
    for (const agent of EXPECTED_AGENTS) {
      expect(createJs, `create.js seeds no agent-memory dir for ${agent}`).toContain(`'${agent}'`);
    }
  });

  it('matches the roster carbon/AGENTS.md documents', () => {
    const agentsMd = readFileSync(join(REPO_ROOT, 'carbon', 'AGENTS.md'), 'utf-8');
    const section = agentsMd.slice(agentsMd.indexOf('## Agent Orchestration'));
    expect(section, 'carbon/AGENTS.md has no Agent Orchestration section').not.toBe('');
    for (const agent of EXPECTED_AGENTS) {
      expect(section, `carbon/AGENTS.md does not document ${agent}`).toContain(`\`${agent}\``);
    }
  });
});
