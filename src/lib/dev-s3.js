/**
 * Host port of the dev-only local S3 (Garage, docker-compose.override.yml),
 * on the same contract as every other DEV_* port: an explicit DEV_S3_PORT
 * wins, else the base port + DEV_PORT_OFFSET.
 *
 * Two byte-identical copies: carbon/scripts/lib/dev-s3.js (docker-up.js
 * publishes the port, dev-init.js writes S3_ENDPOINT) and src/lib/dev-s3.js
 * (`vibecarbon create` writes S3_ENDPOINT, `vibecarbon up` checks the port
 * and rewrites S3_ENDPOINT with the offset). A unit test keeps them equal.
 */
export const DEV_S3_BASE_PORT = 8333;

/** @param {Record<string, string | undefined>} env */
export function devS3Port(env) {
  const explicit = Number.parseInt(env.DEV_S3_PORT || '', 10);
  if (explicit) return explicit;
  const offset = Number.parseInt(env.DEV_PORT_OFFSET || '0', 10) || 0;
  return DEV_S3_BASE_PORT + offset;
}

/** @param {Record<string, string | undefined>} env */
export function devS3Endpoint(env) {
  return `http://localhost:${devS3Port(env)}`;
}
