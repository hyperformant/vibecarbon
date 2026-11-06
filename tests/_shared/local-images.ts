/**
 * The upstream ref of a mirrored image. The mirror is a manifest copy, so this
 * is the same digest from the registry that already has it: a local test proves
 * the same image without waiting for ours to be published.
 */
export function upstreamRef(mirror: {
  upstream: string;
  repo: string;
  tag: string;
  digest: string;
}): string {
  return `${mirror.upstream}/${mirror.repo}:${mirror.tag}@${mirror.digest}`;
}
