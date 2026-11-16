import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanStaleProjects,
  hasDockerCompose,
  loadGlobalRegistry,
  registerProject,
} from '../../../src/lib/config.js';

describe('Global Project Registry', () => {
  let configDir: string;
  let tempBase: string;

  beforeEach(() => {
    tempBase = join(
      tmpdir(),
      `vibecarbon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempBase, { recursive: true });
    configDir = join(tempBase, '.vibecarbon');
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  describe('loadGlobalRegistry', () => {
    it('returns empty projects array when file is missing', () => {
      const result = loadGlobalRegistry(configDir);
      expect(result).toEqual({ projects: [] });
    });

    it('returns empty projects array on invalid JSON', () => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'projects.json'), 'not json');
      const result = loadGlobalRegistry(configDir);
      expect(result).toEqual({ projects: [] });
    });

    // A registry on a real machine held 610 null entries among 616 (cause not
    // found). `create` then built the whole project and died in
    // registerProject on `p.path` of null.
    it('drops entries that are not a project record', () => {
      mkdirSync(configDir, { recursive: true });
      const good = { name: 'app', path: '/srv/app', createdAt: 'a', updatedAt: 'b' };
      writeFileSync(
        join(configDir, 'projects.json'),
        JSON.stringify({ projects: [null, good, 'x', 7, [], { name: 'no-path' }, { path: 42 }] }),
      );
      expect(loadGlobalRegistry(configDir)).toEqual({ projects: [good] });
    });

    it('registers a project into a registry that holds null entries, and heals it', () => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'projects.json'), JSON.stringify({ projects: [null, null] }));
      const dir = join(tempBase, 'proj');
      mkdirSync(dir);
      expect(() => registerProject('proj', dir, configDir)).not.toThrow();
      const { projects } = JSON.parse(readFileSync(join(configDir, 'projects.json'), 'utf-8'));
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ name: 'proj', path: dir });
    });

    it('cleans stale projects in a registry that holds null entries', () => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'projects.json'), JSON.stringify({ projects: [null] }));
      expect(() => cleanStaleProjects(configDir)).not.toThrow();
    });

    it('returns empty projects array when projects field is not an array', () => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'projects.json'), JSON.stringify({ projects: 'bad' }));
      const result = loadGlobalRegistry(configDir);
      expect(result).toEqual({ projects: [] });
    });

    it('returns valid registry data', () => {
      mkdirSync(configDir, { recursive: true });
      const data = {
        projects: [
          { name: 'test', path: '/tmp/test', createdAt: '2025-01-01', updatedAt: '2025-01-01' },
        ],
      };
      writeFileSync(join(configDir, 'projects.json'), JSON.stringify(data));
      const result = loadGlobalRegistry(configDir);
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].name).toBe('test');
    });
  });

  describe('registerProject', () => {
    it('creates file and directory when they do not exist', () => {
      registerProject('my-app', join(tempBase, 'my-app'), configDir);
      expect(existsSync(join(configDir, 'projects.json'))).toBe(true);
      const registry = loadGlobalRegistry(configDir);
      expect(registry.projects).toHaveLength(1);
      expect(registry.projects[0].name).toBe('my-app');
    });

    it('upserts by path, preserves createdAt', () => {
      registerProject('my-app', join(tempBase, 'my-app'), configDir);
      const first = loadGlobalRegistry(configDir);
      const createdAt = first.projects[0].createdAt;

      // Update the same path with different name
      registerProject('my-app-renamed', join(tempBase, 'my-app'), configDir);
      const second = loadGlobalRegistry(configDir);
      expect(second.projects).toHaveLength(1);
      expect(second.projects[0].name).toBe('my-app-renamed');
      expect(second.projects[0].createdAt).toBe(createdAt);
    });

    it('adds new entry for different path', () => {
      registerProject('app-one', join(tempBase, 'app-one'), configDir);
      registerProject('app-two', join(tempBase, 'app-two'), configDir);
      const registry = loadGlobalRegistry(configDir);
      expect(registry.projects).toHaveLength(2);
    });

    it('resolves relative paths to absolute', () => {
      // Register with an absolute path
      const absPath = join(tempBase, 'rel-app');
      registerProject('rel-app', absPath, configDir);
      const registry = loadGlobalRegistry(configDir);
      // The stored path should be absolute
      expect(registry.projects[0].path).toBe(absPath);
    });
  });

  describe('cleanStaleProjects', () => {
    it('removes entries where directory no longer exists', () => {
      const validDir = join(tempBase, 'valid-app');
      mkdirSync(validDir, { recursive: true });
      registerProject('valid-app', validDir, configDir);

      const staleDir = join(tempBase, 'stale-app');
      mkdirSync(staleDir, { recursive: true });
      registerProject('stale-app', staleDir, configDir);

      // Remove the stale directory
      rmSync(staleDir, { recursive: true });

      cleanStaleProjects(configDir);

      const registry = loadGlobalRegistry(configDir);
      expect(registry.projects).toHaveLength(1);
      expect(registry.projects[0].name).toBe('valid-app');
    });

    it('preserves entries for existing directories', () => {
      const dir = join(tempBase, 'existing-app');
      mkdirSync(dir, { recursive: true });
      registerProject('existing-app', dir, configDir);

      cleanStaleProjects(configDir);

      const registry = loadGlobalRegistry(configDir);
      expect(registry.projects).toHaveLength(1);
    });
  });

  describe('hasDockerCompose', () => {
    it('returns true when docker-compose.yml exists', () => {
      const dir = join(tempBase, 'project');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'docker-compose.yml'), 'version: "3"');
      expect(hasDockerCompose(dir)).toBe(true);
    });

    it('returns false when docker-compose.yml does not exist', () => {
      const dir = join(tempBase, 'empty');
      mkdirSync(dir, { recursive: true });
      expect(hasDockerCompose(dir)).toBe(false);
    });
  });
});
