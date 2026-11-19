/**
 * redactCredentials masks credential-shaped values in command output before
 * it is quoted (deploy errors, backup health, e2e host diagnostics). It runs
 * on whole journal and log lines, so it must stay linear: each of its three
 * patterns once rescanned from every position inside a long run, which took
 * seconds on a 50,000-character line and timed out the host-diagnostics test
 * under load.
 */
import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../../../src/lib/redact-credentials.js';

describe('redactCredentials', () => {
  it.each([
    [
      'an assignment whose name holds a keyword',
      'AWS_SECRET_ACCESS_KEY=abc123 next',
      'AWS_SECRET_ACCESS_KEY=<redacted> next',
    ],
    ['a colon separator with spaces', 'db_password : hunter2', 'db_password=<redacted>'],
    ['the keyword in any case', 'apiKey=xyz', 'apiKey=<redacted>'],
    [
      'a keyword assignment inside a value',
      'url=https://x/?TOKEN=abc',
      'url=https://x/?TOKEN=<redacted>',
    ],
    ['a bearer header', 'Authorization: Bearer eyJhbGciOi', 'Authorization: Bearer <redacted>'],
    ['URL userinfo', 'postgres://app:pw@db:5432/app', 'postgres://<redacted>@db:5432/app'],
    [
      'URL userinfo whose scheme follows a dotted prefix',
      'see 9.s3://k:s@host',
      'see 9.s3://<redacted>@host',
    ],
  ])('masks %s', (_name, line, expected) => {
    expect(redactCredentials(line)).toBe(expected);
  });

  it.each([
    ['a name without a keyword', 'region=fsn1 size=cx22'],
    ['a keyword not followed by a separator', 'rotating the KEY now'],
    ['a URL without userinfo', 'https://example.com/path'],
  ])('leaves %s alone', (_name, line) => {
    expect(redactCredentials(line)).toBe(line);
  });

  // 200,000 characters each. Linear, these take a few milliseconds even on a
  // loaded runner; the old patterns took 15 s or more, past the test limit.
  it.each([
    ['one long word', 'x'.repeat(200_000)],
    ['a long dotted run', 'a.'.repeat(100_000)],
    ['a scheme followed by no userinfo', `https://${'a'.repeat(200_000)}`],
    ['a keyword repeated with no separator', 'KEY'.repeat(66_000)],
  ])('stays linear on %s', (_name, line) => {
    expect(redactCredentials(line)).toBe(line);
  });
});
