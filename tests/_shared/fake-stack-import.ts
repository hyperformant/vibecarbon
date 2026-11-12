import { readFileSync } from 'node:fs';
import { createTempDir } from './temp-dir.js';

/**
 * The workspace a hand-rolled fake Stack needs for importStackState
 * (src/lib/iac/index.js), the one way src imports a deployment: a real
 * directory (one per call, removed by the test setup after the file) and a
 * `pulumiCommand.run` that answers `stack import --file <f>` by handing the
 * file's deployment to `onImport`. What `onImport` throws, the import throws.
 *
 *   const stack = { name, exportStack, workspace: importingWorkspace(onImport) };
 */
export function importingWorkspace(
  // biome-ignore lint/suspicious/noExplicitAny: a test's deployment fixture has any shape
  onImport: (deployment: any) => unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    workDir: createTempDir('fake-stack-workdir-'),
    envVars: {},
    pulumiCommand: {
      command: '/nonexistent/fake-pulumi',
      run: async (args: string[]) => {
        if (args[0] !== 'stack' || args[1] !== 'import') {
          throw new Error(`the fake pulumi runs only \`stack import\`, not: ${args.join(' ')}`);
        }
        const file = args[args.indexOf('--file') + 1];
        await onImport(JSON.parse(readFileSync(file, 'utf8')));
        return { stdout: '', stderr: '', code: 0 };
      },
    },
    ...extra,
  };
}
