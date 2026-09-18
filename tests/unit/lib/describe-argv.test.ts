/**
 * Tests for describeArgv() in src/lib/command.js
 *
 * describeArgv() redacts the ssh/scp `-i <key>` identity path so a
 * `Command failed: …` message or CI/DEBUG debug line never carries the
 * operator's key path.
 */

import { describe, expect, it } from 'vitest';
import { describeArgv } from '../../../src/lib/command.js';

describe('describeArgv', () => {
  it('replaces the token after -i with <key>', () => {
    expect(
      describeArgv([
        'ssh',
        '-i',
        '/home/x/.vibecarbon/deploy_key_prod',
        '-o',
        'BatchMode=yes',
        '--',
        'root@1.1.1.1',
        'docker',
        'ps',
      ]),
    ).toBe('ssh -i <key> -o BatchMode=yes -- root@1.1.1.1 docker ps');
  });

  it('leaves argv without -i unchanged', () => {
    expect(describeArgv(['docker', 'ps', '-a'])).toBe('docker ps -a');
  });

  it('leaves a trailing -i with no value as-is', () => {
    expect(describeArgv(['ssh', 'root@1.1.1.1', '-i'])).toBe('ssh root@1.1.1.1 -i');
  });
});
