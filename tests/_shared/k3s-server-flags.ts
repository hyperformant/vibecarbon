/**
 * The `k3s server` arguments a real master installs with, read out of
 * carbon/cloud-init/k3s/master-init.sh. The k3s smoke test runs these, so a flag
 * added there is tested with no edit to the test.
 */

/** Shell words of one argument line, quotes removed. Enough for this list. */
function words(line: string): string[] {
  return [...line.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map((m) => m[0].replaceAll('"', ''));
}

/**
 * @param script - master-init.sh's text
 * @param vars - the script's shell variables and template values, by name
 * @returns one argv entry per word, with every variable filled in
 */
export function k3sServerFlags(script: string, vars: Record<string, string>): string[] {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => /\bsh -s - server \\$/.test(line));
  if (start === -1) throw new Error('no k3s server install line in the script');
  const flags: string[] = [];
  for (const line of lines.slice(start + 1)) {
    flags.push(...words(line.replace(/\\$/, '').replace(/; then$/, '')));
    if (!line.endsWith('\\')) break;
  }
  return flags.map((flag) =>
    flag.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced: string, bare: string) => {
      const name = braced ?? bare;
      if (!(name in vars)) throw new Error(`${name} is not given to k3sServerFlags`);
      return vars[name];
    }),
  );
}
