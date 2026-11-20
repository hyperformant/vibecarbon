# CSI images start on our ghcr mirrors - SHARED SNIPPET, every master. Kept
# terse: user data is capped (32KiB on one provider). Why, and the pairs:
# images.js csiInstallImageRewrites. Pinned by csi-install-rewrite.test.ts.
CSI_IMAGE_REWRITES="${csi_image_rewrites}"
# csi_fetch_mirrored <url> <file>: <file> = the manifest, refs on the mirrors.
csi_fetch_mirrored() {
  curl -fsSL --max-time 120 "$1" -o "$2.upstream" || { echo "CSI manifest download failed: $1"; return 1; }
  if ! CSI_IMAGE_REWRITES="$CSI_IMAGE_REWRITES" awk '
BEGIN { n = split(ENVIRON["CSI_IMAGE_REWRITES"], r, "\n")
  for (i = 1; i <= n; i++) if (split(r[i], p, " ") == 2) { to[p[1]] = p[2]; k++; h = substr(p[1], 1, index(p[1], "/") - 1); if (h ~ /[.:]/) away[h] = 1 }
  if (!k) { print "FATAL: no CSI image rewrites were rendered into this script" > "/dev/stderr"; exit 1 } }
match($0, /^[ \t]*(-[ \t]+)?image:[ \t]+/) { head = substr($0, 1, RLENGTH); v = substr($0, RLENGTH + 1)
  ref = v; sub(/[ \t].*/, "", ref); tail = substr(v, length(ref) + 1); q = ""
  if (ref ~ /^".+"$/) { q = "\""; ref = substr(ref, 2, length(ref) - 2) }
  if (ref in to) { $0 = head q to[ref] q tail; seen[ref] = 1 }
  else for (h in away) if (index(ref, h "/") == 1) { print "FATAL: the CSI manifest still pulls " ref " from " h > "/dev/stderr"; bad = 1 } }
{ print }
END { if (!k) exit 1
  for (f in to) if (!(f in seen)) { print "FATAL: the CSI manifest has no image " f " to move onto its mirror" > "/dev/stderr"; bad = 1 }
  exit (bad ? 1 : 0) }' "$2.upstream" > "$2.rewritten"; then
    echo "FATAL: $1 does not carry the images src/lib/images.js mirrors; re-derive CSI_SIDECAR_MIRRORS from it" >&2
    exit 1
  fi
  mv "$2.rewritten" "$2"
}
