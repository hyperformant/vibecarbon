/**
 * A compose node's wal-g role FILE surface, for harnesses that drive the real
 * compose role code (writeComposeWalgRole and the role-file reads in
 * compose/ha.js) through a string ssh seam.
 *
 * A role write (composeWalgRoleWriteShell, sent as `sh -c <script>`) answers
 * its read-back, `WALG_ROLE_FILE=<the role in the script>`; a role read
 * (walgRoleReadShell on `.vibecarbon-role`) answers `WALG_ROLE_FILE=<current>`.
 * Anything else is undefined, for the caller's own stub to answer.
 */

/** The role a compose role-file write sets, or null for any other command. */
export function composeRoleWriteOf(command: string): 'primary' | 'standby' | null {
  if (!command.includes('.vibecarbon-role')) return null;
  const m = /printf '%s\\n' (primary|standby) > walg-role\.tmp/.exec(command);
  return (m?.[1] as 'primary' | 'standby' | undefined) ?? null;
}

export function composeRoleReply(command: string, current = 'primary'): string | undefined {
  const wrote = composeRoleWriteOf(command);
  if (wrote) return `WALG_ROLE_FILE=${wrote}\n`;
  if (command.includes('.vibecarbon-role') && command.includes('WALG_ROLE_FILE')) {
    return `WALG_ROLE_FILE=${current}\n`;
  }
  return undefined;
}

/** An argv ssh seam (ssh.js sshRun's contract) over a string one: `sh -c <script>` joined. */
export const argvOver =
  <T>(run: (ip: string, k: string, command: string, o?: unknown) => Promise<T>) =>
  (ip: string, k: string, argv: string[], o?: unknown) =>
    run(ip, k, argv.join(' '), o);
