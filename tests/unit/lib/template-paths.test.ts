import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  projectPathFor,
  TEMPLATE_RENAMES,
  templatePathFor,
} from '../../../src/lib/template-paths.js';
import { getFilePolicy, getUpgradeableFiles } from '../../../src/lib/upgrade-policy.js';

const TEMPLATE_DIR = join(process.cwd(), 'carbon');

describe('template-paths: names npm refuses to pack', () => {
  it('maps the project .gitignore to a template name npm keeps, and back', () => {
    expect(templatePathFor('.gitignore')).toBe('_gitignore');
    expect(projectPathFor('_gitignore')).toBe('.gitignore');
  });

  it('applies at any depth (basename-keyed)', () => {
    expect(templatePathFor('k8s/.gitignore')).toBe('k8s/_gitignore');
    expect(projectPathFor('k8s/_gitignore')).toBe('k8s/.gitignore');
  });

  it('leaves every other path untouched', () => {
    for (const p of [
      'package.json',
      'src/index.ts',
      '.env.example',
      '.dockerignore',
      'gitignore',
    ]) {
      expect(templatePathFor(p)).toBe(p);
      expect(projectPathFor(p)).toBe(p);
    }
  });

  it('every renamed file exists in the template under its shipped name only', () => {
    for (const [projectName, templateName] of Object.entries(TEMPLATE_RENAMES)) {
      expect(existsSync(join(TEMPLATE_DIR, templateName)), `carbon/${templateName}`).toBe(true);
      expect(
        existsSync(join(TEMPLATE_DIR, projectName)),
        `carbon/${projectName} must not exist`,
      ).toBe(false);
    }
  });

  it('upgrade sees the project name, so .gitignore keeps its merge policy', () => {
    const files = getUpgradeableFiles(TEMPLATE_DIR);
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('_gitignore');
    expect(getFilePolicy('.gitignore')).toBe('merge');
  });
});
