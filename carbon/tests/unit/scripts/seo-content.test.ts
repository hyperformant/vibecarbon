import { describe, expect, it } from 'vitest';
import { isDraft, parseFrontmatter, substituteMdxProps } from '../../../scripts/lib/seo-content';

describe('substituteMdxProps', () => {
  const props = { projectName: 'My SaaS', adminEmail: 'admin@example.com' };

  it('replaces known {props.*} tokens with their values', () => {
    expect(
      substituteMdxProps('How {props.projectName} ("we") collects your information.', props)
    ).toBe('How My SaaS ("we") collects your information.');
  });

  it('replaces every occurrence, including inside markdown emphasis', () => {
    expect(
      substituteMdxProps('Use of {props.projectName}. Contact us at **{props.adminEmail}**.', props)
    ).toBe('Use of My SaaS. Contact us at **admin@example.com**.');
  });

  it('leaves unknown props tokens untouched', () => {
    expect(substituteMdxProps('Hello {props.unknownThing}!', props)).toBe(
      'Hello {props.unknownThing}!'
    );
  });

  // Repo convention: replacement FUNCTIONS everywhere — a replacement string
  // would expand $-patterns ($&, $1, $$) in substituted values.
  it('preserves literal $-patterns in substituted values', () => {
    expect(substituteMdxProps('Name: {props.projectName}', { projectName: 'A$& $$ $1 B' })).toBe(
      'Name: A$& $$ $1 B'
    );
  });

  it('does not resolve prototype members as props', () => {
    expect(substituteMdxProps('{props.constructor}', props)).toBe('{props.constructor}');
  });
});

describe('isDraft', () => {
  it('is true when frontmatter has draft: true', () => {
    expect(isDraft({ title: 'WIP post', draft: 'true' })).toBe(true);
  });

  it('is false when draft is absent or false', () => {
    expect(isDraft({ title: 'Live post' })).toBe(false);
    expect(isDraft({ title: 'Live post', draft: 'false' })).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('parses key-value frontmatter and returns the body', () => {
    const { fm, body } = parseFrontmatter(
      '---\ntitle: Hello\ndraft: true\ndescription: "A: colon value"\n---\n# Body\n'
    );
    expect(fm).toEqual({ title: 'Hello', draft: 'true', description: 'A: colon value' });
    expect(body).toBe('# Body\n');
  });

  it('returns the whole content as body when there is no frontmatter', () => {
    const { fm, body } = parseFrontmatter('# Just markdown\n');
    expect(fm).toEqual({});
    expect(body).toBe('# Just markdown\n');
  });
});
