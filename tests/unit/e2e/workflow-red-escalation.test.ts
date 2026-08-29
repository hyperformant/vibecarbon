/**
 * Census: the e2e dispatch workflow must escalate red legs into a durable
 * artifact — a labeled GitHub issue — and the pieces that make that work
 * must stay wired to each other.
 *
 * Written after the 2026-08-23 incident: the DigitalOcean leg failed four
 * consecutive dispatches (~5.5 hours of active iteration, runs
 * 32653854612..32670715722) and left zero durable trace — no issue, no
 * ledger entry, nothing. The workflow is dispatch-only with no schedule,
 * so a red run is a red row in a tab nobody revisits; the reds sat
 * undiscovered for six days. The `escalate` job closes that gap, and this
 * test keeps it closed: without it, deleting or de-wiring the job would
 * compile, pass every other census, and silently reopen the exact failure
 * mode it was built for.
 *
 * What is pinned (each line is a way the escalation has to silently rot):
 *  - the job exists, `needs: matrix`, and fires on the aggregate
 *    `needs.matrix.result == 'failure'` under `always()` — for a matrix
 *    job that aggregate is 'failure' iff ANY leg failed, which is the
 *    trigger contract;
 *  - it holds `issues: write` (files/comments) and `actions: read`
 *    (same-run jobs listing + artifact download) — the workflow default is
 *    `contents: read` only, so losing either permission is a runtime 403
 *    that only ever manifests on an already-red run;
 *  - its artifact download pattern matches the legs' upload name prefix,
 *    and its log lookup matches the legs' tee filename (`ci-batch-`), so a
 *    rename on the upload side can't quietly turn every escalation into
 *    "no log artifact for this leg";
 *  - its leg-name parse (`E2E (<provider>)`) matches the matrix job's
 *    actual `name:` template, so a job rename can't quietly turn the
 *    escalation into a no-op ("no failed E2E leg found").
 */
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/e2e-us-perf.yml';

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
};

function loadJobs(): Record<string, Job> {
  const doc = loadYaml(readFileSync(WORKFLOW_PATH, 'utf8')) as { jobs?: Record<string, Job> };
  expect(doc.jobs, `${WORKFLOW_PATH}: no jobs`).toBeDefined();
  return doc.jobs ?? {};
}

describe('e2e-us-perf.yml red-leg escalation (the `escalate` job)', () => {
  it('exists, needs the matrix job, and fires on any failed leg (aggregate failure under always())', () => {
    const escalate = loadJobs().escalate;
    expect(
      escalate,
      'the `escalate` job was removed — red dispatches are silent again',
    ).toBeDefined();
    const needs = Array.isArray(escalate.needs) ? escalate.needs : [escalate.needs];
    expect(needs).toContain('matrix');
    expect(escalate.if).toContain('always()');
    expect(escalate.if).toContain("needs.matrix.result == 'failure'");
  });

  it('holds exactly the permissions the escalation needs: issues write, actions read', () => {
    const { permissions } = loadJobs().escalate;
    expect(permissions?.issues).toBe('write');
    expect(permissions?.actions).toBe('read');
  });

  it("downloads the legs' artifacts by the same name the legs upload under", () => {
    const jobs = loadJobs();
    const upload = jobs.matrix.steps?.find((s) => s.uses?.startsWith('actions/upload-artifact'));
    const download = jobs.escalate.steps?.find((s) =>
      s.uses?.startsWith('actions/download-artifact'),
    );
    expect(upload?.with?.name, 'matrix upload step missing').toBeDefined();
    expect(download?.with?.pattern, 'escalate download step missing').toBeDefined();
    // Upload name is `<prefix>-${{ matrix.provider }}`; the download pattern
    // must be that same prefix globbed.
    const prefix = String(upload?.with?.name ?? '').replace(/\$\{\{.*$/, '');
    expect(download?.with?.pattern).toBe(`${prefix}*`);
  });

  it('parses leg names and log filenames by the conventions the matrix job actually uses', () => {
    const jobs = loadJobs();
    const script = jobs.escalate.steps?.map((s) => s.run ?? '').join('\n') ?? '';
    // Leg-name parse ↔ matrix job name template.
    expect(jobs.matrix.name).toBe('E2E (${{ matrix.provider }})');
    expect(script).toContain('E2E (');
    // Log lookup ↔ the tee filename in the matrix run step.
    const matrixScript = jobs.matrix.steps?.map((s) => s.run ?? '').join('\n') ?? '';
    expect(matrixScript).toContain('ci-batch-');
    expect(script).toContain('ci-batch-');
  });

  it('feeds dispatch inputs to the script via env, never interpolated into the body', () => {
    const step = loadJobs().escalate.steps?.find((s) => s.run?.includes('gh issue'));
    expect(step, 'escalate issue step missing').toBeDefined();
    // The free-text `scenarios` input must enter through env (script
    // injection hygiene — same rule the rest of this workflow follows).
    expect(JSON.stringify(step?.env ?? {})).toContain('inputs.scenarios');
    expect(step?.run).not.toContain('${{');
  });
});
