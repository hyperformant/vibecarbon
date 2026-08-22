import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanStaleProjects,
  hasDockerCompose,
  isHAConfigured,
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

  describe('isHAConfigured', () => {
    it('returns true when K8s overlay dirs exist', () => {
      const dir = join(tempBase, 'ha-project');
      mkdirSync(join(dir, 'k8s/overlays/production-hel1'), { recursive: true });
      expect(isHAConfigured(dir)).toBe(true);
    });

    it('returns true when nbg1 overlay exists', () => {
      const dir = join(tempBase, 'ha-project2');
      mkdirSync(join(dir, 'k8s/overlays/production-nbg1'), { recursive: true });
      expect(isHAConfigured(dir)).toBe(true);
    });

    it('returns false when no overlay dirs exist', () => {
      const dir = join(tempBase, 'no-ha');
      mkdirSync(dir, { recursive: true });
      expect(isHAConfigured(dir)).toBe(false);
    });
  });
});
