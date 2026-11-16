/**
 * The operator's environment name for a stack name: HA tiers run
 * `<env>-primary` and `<env>-standby`, and every command takes the environment.
 * @param {string | null | undefined} stackName
 * @returns {string}
 */
export function environmentForStack(stackName) {
  return String(stackName ?? '').replace(/-(primary|standby)$/, '');
}
