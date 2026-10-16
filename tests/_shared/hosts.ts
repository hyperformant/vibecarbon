/**
 * Whether `text` (a source line, a shell string, a `name=image` argument)
 * names `host` as a whole hostname: split on every character a hostname
 * cannot hold, then compare tokens exactly. `registry.k8s.io/x:v1`,
 * `"https://download.docker.com/linux"` and `img=registry.k8s.io/y` all name
 * their host; `notregistry.k8s.io` does not. Exact token equality, not a
 * substring test, so it states what the assertion means (CodeQL
 * js/incomplete-url-substring-sanitization).
 */
export function namesHost(text: string, host: string): boolean {
  return text.split(/[^A-Za-z0-9.-]+/).some((token) => token.replace(/\.$/, '') === host);
}
