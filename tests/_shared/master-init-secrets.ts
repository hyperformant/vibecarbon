/**
 * The Secrets a k3s master's boot script creates, read out of the script:
 *
 *   kubectl -n <namespace> create secret generic <name> \
 *     --from-literal=<key>="${<template var>}" \
 *     --dry-run=client -o yaml | kubectl apply -f -
 *
 * The cloud-secrets census and the Docker-tier takeover test both read them
 * here, so neither keeps a list of its own. A `create secret` this parser
 * cannot read throws, so a reworded block fails loudly instead of vanishing
 * from both tests.
 */

export type MasterInitSecret = {
  namespace: string;
  name: string;
  /** Each key and the template variable its value is rendered from. */
  keys: Record<string, string>;
  /** The whole command, `kubectl -n` through `kubectl apply -f -`, as the script runs it. */
  command: string;
};

const BLOCK =
  /^kubectl -n (\S+) create secret generic (\S+) \\\n((?:[ \t]+--from-literal=\S+ \\\n)+)[ \t]+--dry-run=client -o yaml \| kubectl apply -f -$/gm;
const LITERAL = /--from-literal=([^=\s]+)="\$\{(\w+)\}"/g;

/** @param script - a master boot script's text, before or after rendering */
export function masterInitSecrets(script: string): MasterInitSecret[] {
  const secrets: MasterInitSecret[] = [];
  for (const [command, namespace, name, literals] of script.matchAll(BLOCK)) {
    const keys: Record<string, string> = {};
    for (const [, key, variable] of literals.matchAll(LITERAL)) keys[key] = variable;
    const lines = literals.trim().split('\n').length;
    if (Object.keys(keys).length !== lines) {
      throw new Error(`${namespace}/${name}: a --from-literal line is not key="\${var}"`);
    }
    secrets.push({ namespace, name, keys, command });
  }
  const creates = script.match(/\bcreate secret\b/g)?.length ?? 0;
  if (creates !== secrets.length) {
    throw new Error(`the script runs ${creates} create secret commands, ${secrets.length} parsed`);
  }
  return secrets;
}
