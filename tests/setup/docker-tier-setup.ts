import { execFileSync, spawnSync } from 'node:child_process';
import { DB_IMAGE_OVERRIDE_ENV, DB_IMAGE_TAG, NODE_RUNTIME_IMAGE } from '../../src/lib/images.js';

const build = (tag: string, context: string) =>
  execFileSync('docker', ['build', '--quiet', '--tag', tag, context], {
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 600_000,
  });

/**
 * The Docker tier tests this checkout, so it never needs an image we have to
 * publish first. Our db image is built from docker/postgres-walg and handed to
 * every test and every `vibecarbon create` through the override a deploy already
 * honours. An operator who set the override keeps their choice.
 *
 * carbon/Dockerfile builds FROM the node runtime by name, so an unpublished
 * revision is built under that name for the run and removed afterwards. A
 * digest in the ref means it is published, and an image already here is used.
 */
export default function setup() {
  if (process.env.DOCKER_INTEGRATION !== 'true') return;
  if (!process.env[DB_IMAGE_OVERRIDE_ENV]) {
    const ref = `vctest-postgres:${DB_IMAGE_TAG}`;
    build(ref, 'docker/postgres-walg');
    process.env[DB_IMAGE_OVERRIDE_ENV] = ref;
  }
  const inspect = spawnSync('docker', ['image', 'inspect', NODE_RUNTIME_IMAGE], {
    stdio: 'ignore',
  });
  if (NODE_RUNTIME_IMAGE.includes('@') || inspect.status === 0) return;
  build(NODE_RUNTIME_IMAGE, 'docker/node-runtime');
  // A docker-container builder cannot see a local image; the daemon's own can.
  process.env.BUILDX_BUILDER = 'default';
  return () => {
    spawnSync('docker', ['image', 'rm', NODE_RUNTIME_IMAGE], { stdio: 'ignore' });
  };
}
