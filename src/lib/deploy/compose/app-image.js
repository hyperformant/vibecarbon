/**
 * The app image for compose servers: built ONCE on the operator's machine
 * (amd64), then sent to each server by layer delta (deliverImage,
 * layer-delta.js). Each server pulls the runtime base itself at datacenter
 * speed, so only the app's own layers cross the operator's uplink.
 *
 * Single compose delivers to its one server, compose-ha to both servers in
 * parallel, and a compose scale to its replacement. A server builds the image
 * itself (remote-build.js) only when this machine has no docker (direct mode):
 * tests/unit/deploy/image-delivery-census.test.ts holds every such call to that
 * gate.
 */

import { runCommandAsync } from '../../command.js';
import { perfAsync } from '../../perf.js';
import { shEscape } from '../../shell.js';
import { readRuntimeBaseRef } from '../image.js';
import { deliverImage } from '../layer-delta.js';
import { AMD64_BUILD_HINT, PLATFORM_BUILD_FLAG } from '../platform.js';
import { buildArgFlags, collectComposeBuildArgs } from './build-args.js';
import { sshRunAsync } from './index.js';

/**
 * Build the app image on this machine, tagged `tag`. Pinned to amd64: without
 * the pin the image inherits the operator's architecture (an Apple Silicon
 * operator shipped arm64 to an amd64 VPS). The VITE_* build args are the same
 * ones the server's runtime .env carries, since Vite inlines them at build
 * time. Silent (it overlaps other spinners); a failure carries docker's last
 * lines and the amd64 hint.
 *
 * @param {{ tag: string, projectName: string, domain?: string | null, cwd?: string }} args
 * @returns {Promise<unknown>}
 */
export async function buildComposeAppImage({ tag, projectName, domain, cwd = process.cwd() }) {
  const buildArgs = collectComposeBuildArgs(cwd, { projectName, domain });
  try {
    return await runCommandAsync(
      ['docker', 'build', PLATFORM_BUILD_FLAG, ...buildArgFlags(buildArgs), '-t', tag, cwd],
      { silent: true },
    );
  } catch (err) {
    const detail = `${err?.stderr || ''}${err?.stdout || ''}`.trim();
    throw new Error(
      `docker build failed for ${tag}. ${AMD64_BUILD_HINT}` +
        (detail ? `\n${detail.split('\n').slice(-40).join('\n')}` : ''),
      { cause: err },
    );
  }
}

/**
 * Put the locally built `tag` on one server. Starts the server's pull of the
 * runtime base the project's Dockerfile names NOW, before `built` is awaited,
 * so the pull overlaps the local build and the host-side save; then sends the
 * delta. Returns the in-flight delivery; the caller awaits it at its barrier
 * (compose references the image, so it must be present before compose up).
 *
 * @param {{ ip: string, sshKeyPath: string, tag: string, built?: Promise<unknown> | null, cwd?: string }} args
 * @returns {Promise<void>}
 */
export function deliverComposeAppImage({ ip, sshKeyPath, tag, built, cwd = process.cwd() }) {
  // The ref the image was built FROM, and exactly the ref the delta looks up.
  // A Dockerfile without the ARG gets no base pull and a delta of every layer.
  const baseRef = readRuntimeBaseRef(cwd);
  const basePull = baseRef
    ? perfAsync('deploy.image.basePull', () =>
        // Inspect first: the ref is immutable (tag pinned, digest once
        // published), so a server that already holds it, which is every warm
        // redeploy, asks no registry and a GHCR blip cannot fail it.
        sshRunAsync(
          ip,
          sshKeyPath,
          `docker image inspect ${shEscape(baseRef)} >/dev/null 2>&1 || docker pull ${shEscape(baseRef)}`,
          { timeout: 600_000 },
        ),
      )
    : undefined;
  // deliverImage owns the pull's failure (with its own hint); this only keeps
  // a pull that fails while the build is still running from surfacing as an
  // unhandled rejection before deliverImage attaches its await.
  basePull?.catch(() => {});
  return (async () => {
    await built;
    await perfAsync('deploy.image.transfer', () =>
      deliverImage({
        tag,
        sshTarget: `root@${ip}`,
        sshKey: sshKeyPath,
        runtime: 'docker',
        basePull,
        baseRef: baseRef ?? '',
      }),
    );
  })();
}
