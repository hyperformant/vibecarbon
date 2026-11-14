/**
 * removeStackBackup (lib/iac/state-history.js): Pulumi's DIY backend keeps the
 * previous copy of a stack's state as `.pulumi/stacks/<project>/<stack>.json.bak`
 * and `stack rm` leaves it behind. It goes once the stack's resources are known
 * to be gone, and ONLY then: on a path that removes a stack whose resources may
 * still exist it is the last record of what may have leaked.
 *
 * The census at the bottom holds every `removeStack` call in src to that rule,
 * reading the body of the function that encloses each call.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as progress from '../../../src/lib/cli/progress.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const { removeStackBackup } = await import('../../../src/lib/iac/state-history.js');

const KEY = '.pulumi/stacks/proj/e1.json.bak';

function fakeS3(objects: string[], failWith?: Error) {
  const deleted: Array<[string, string[]]> = [];
  return {
    deleted,
    objects,
    endpoint: 'https://fsn1.your-objectstorage.com',
    deleteObjectKeys: vi.fn(async (bucket: string, keys: string[]) => {
      if (failWith) throw failWith;
      deleted.push([bucket, keys]);
      for (const k of keys) {
        const i = objects.indexOf(k);
        if (i >= 0) objects.splice(i, 1);
      }
    }),
  };
}

describe('removeStackBackup', () => {
  it('deletes the backup key from an s3 backend', async () => {
    const s3 = fakeS3([KEY, '.pulumi/stacks/proj/e1.json']);
    const gone = await removeStackBackup({
      backendUrl: 's3://state-bucket?endpoint=fsn1.your-objectstorage.com&region=fsn1',
      pulumiProject: 'proj',
      stackName: 'e1',
      s3,
    });
    expect(gone).toBe(true);
    expect(s3.deleted).toEqual([['state-bucket', [KEY]]]);
    expect(s3.objects).toEqual(['.pulumi/stacks/proj/e1.json']);
  });

  it('deletes the backup file from a file backend', async () => {
    const root = createTempDir('vc-stack-backup-');
    const dir = join(root, '.pulumi/stacks/proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'e1.json.bak'), '{}');
    writeFileSync(join(dir, 'e2.json.bak'), '{}');
    const gone = await removeStackBackup({
      backendUrl: `file://${root}`,
      pulumiProject: 'proj',
      stackName: 'e1',
    });
    expect(gone).toBe(true);
    expect(readdirSync(dir)).toEqual(['e2.json.bak']);
  });

  it('a missing backup counts as gone', async () => {
    const root = createTempDir('vc-stack-backup-missing-');
    expect(
      await removeStackBackup({
        backendUrl: `file://${root}`,
        pulumiProject: 'proj',
        stackName: 'e1',
      }),
    ).toBe(true);
    // S3 DeleteObject on a key that is not there answers 204.
    const s3 = fakeS3([]);
    expect(
      await removeStackBackup({
        backendUrl: 's3://state-bucket?endpoint=fsn1.your-objectstorage.com',
        pulumiProject: 'proj',
        stackName: 'e1',
        s3,
      }),
    ).toBe(true);
  });

  it('a delete error is swallowed and reported as false', async () => {
    const s3 = fakeS3([KEY], new Error('AccessDenied SENTINEL-secret'));
    const gone = await removeStackBackup({
      backendUrl: 's3://state-bucket?endpoint=fsn1.your-objectstorage.com',
      pulumiProject: 'proj',
      stackName: 'e1',
      s3,
    });
    expect(gone).toBe(false);
    expect(s3.objects).toEqual([KEY]);
  });

  it('says nothing for a backend vibecarbon does not manage', async () => {
    const log = vi.spyOn(progress, 'progressLog').mockImplementation(() => {});
    try {
      expect(
        await removeStackBackup({
          backendUrl: 'azblob://container',
          pulumiProject: 'proj',
          stackName: 'e1',
        }),
      ).toBe(false);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('names the HTTP status when the error has no code', async () => {
    const log = vi.spyOn(progress, 'progressLog').mockImplementation(() => {});
    try {
      const err = Object.assign(new Error('x'), { $metadata: { httpStatusCode: 403 } });
      const s3 = fakeS3([KEY], err);
      const gone = await removeStackBackup({
        backendUrl: 's3://state-bucket?endpoint=fsn1.your-objectstorage.com',
        pulumiProject: 'proj',
        stackName: 'e1',
        s3,
      });
      expect(gone).toBe(false);
      expect(String(log.mock.calls[0]?.[0])).toContain('HTTP 403');
    } finally {
      log.mockRestore();
    }
  });

  it('the failure line never contains the error message', async () => {
    const log = vi.spyOn(progress, 'progressLog').mockImplementation(() => {});
    try {
      const s3 = fakeS3([KEY], new Error('boom SENTINEL-secret-9f3 https://x/state-bucket/key'));
      const gone = await removeStackBackup({
        backendUrl: 's3://state-bucket?endpoint=fsn1.your-objectstorage.com',
        pulumiProject: 'proj',
        stackName: 'e1',
        s3,
      });
      expect(gone).toBe(false);
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('SENTINEL-secret-9f3');
      expect(JSON.stringify(log.mock.calls)).toContain('unknown error');
    } finally {
      log.mockRestore();
    }
  });

  it('a backend vibecarbon does not manage is not touched and reports false', async () => {
    expect(
      await removeStackBackup({
        backendUrl: 'https://api.pulumi.com',
        pulumiProject: 'proj',
        stackName: 'e1',
      }),
    ).toBe(false);
  });
});

// A source census passes on dead code when it greps the whole file. This one
// slices the body of the function around each `removeStack` call, and the
// calls it looks for are real code lines, not comments.
const SRC = join(__dirname, '../../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith('.js')
        ? [join(dir, e.name)]
        : [],
  );
}

const codeOnly = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/** The top-level function that encloses line `at` (column-0 `function` to column-0 `}`). */
function enclosingFunction(lines: string[], at: number) {
  let start = at;
  while (start > 0 && !/^(export )?(async )?function\b/.test(lines[start])) start--;
  let end = at;
  while (end < lines.length - 1 && lines[end] !== '}') end++;
  return lines.slice(start, end + 1).join('\n');
}

describe('census: every removeStack call decides about the backup', () => {
  const calls = sourceFiles(SRC).flatMap((file) => {
    const lines = readFileSync(file, 'utf8').split('\n');
    return lines.flatMap((line, i) =>
      /\.removeStack\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)
        ? [{ file: file.slice(SRC.length + 1), body: enclosingFunction(lines, i) }]
        : [],
    );
  });

  it('finds the two removeStack calls', () => {
    expect(calls.map((c) => c.file)).toEqual(['lib/iac/index.js', 'lib/iac/index.js']);
  });

  it('each is in a function that calls removeStackBackup or says why not', () => {
    for (const { file, body } of calls) {
      const calls = /\bremoveStackBackup\(/.test(codeOnly(body));
      const why = /\/\/[^\n]*backup[^\n]*\bnot\b/i.test(body);
      expect(calls || why, `${file}: ${body.slice(0, 80)}`).toBe(true);
    }
  });

  it('removeStackState takes the backup only when its caller says the stack holds nothing', () => {
    const { body } = calls[1];
    expect(codeOnly(body)).toMatch(
      /if \(options\.removeBackup === true\)[\s\S]*removeStackBackup\(/,
    );
  });

  it('each destroy.js removeStackState call states removeBackup, and a false has its reason', () => {
    const text = readFileSync(join(SRC, 'destroy.js'), 'utf8');
    const sites = [...text.matchAll(/removeStackState\(\s*stackEnv,\s*\{/g)];
    expect(sites.length).toBe(2);
    const verdicts = sites.map((m) => {
      const after = text.slice(m.index, m.index + 400);
      const before = text.slice(Math.max(0, (m.index ?? 0) - 700), m.index);
      const flag = after.match(/removeBackup:\s*(true|false)/)?.[1];
      if (flag === 'false') expect(before).toMatch(/last record/);
      return flag;
    });
    expect(verdicts.sort()).toEqual(['false', 'true']);
  });
});
