# The target half of the layer delta (src/lib/deploy/layer-delta.js). Run as
#   ssh <target> sh -c '<this file>' layer-delta <runtime> <platform> <tag> <ref> [<registry-ref>]
# or, for a push deferred until the registry serves (deliverImage pushAfter),
#   ssh <target> sh -c '<this file>' layer-delta push <ref> <registry-ref>
# which pushes an image an earlier run imported, through the same steps.
# with the delta tar on stdin: manifest.json (Layers l0..lN-1, Config
# config.json), config.json, the layer files the target lacked, and fill.txt,
# one `<index> <diffID> <source>` line per layer the target already holds.
#
#   runtime       docker | k3s
#   platform      the platform deploys run (platform.js TARGET_PLATFORM)
#   tag           the image's RepoTag (docker: what is loaded and verified)
#   ref           the name the store gives it (k3s: ctr's normalized name)
#   registry-ref  k3s only: tag the import under this ref and push it there
#
# POSIX sh with no jq: a k3s node's image and a busybox base have neither bash
# nor jq. The JSON read here is written by docker or ctr, and the values taken
# from it (blob paths, digests) carry no whitespace or quotes; the final check
# compares what the store loaded against the manifest's diffIDs, so a misread
# fails the deploy instead of tagging a wrong image.
#
# Its stderr becomes the deploy's one-line error (`image delivery failed:
# <first line>`), so it never echoes the environment and never traces.
set -eu

# `k3s ctr` on a node. Split on purpose: it is a command and its subcommand.
ctr=${VC_CTR:-k3s ctr}

# Tag <ref> as <registry-ref> when they differ, then push it to that registry.
# The one push path: the end of a k3s delivery and push mode both use it.
push_to_registry() {
  if [ "$2" != "$1" ]; then
    $ctr -n k8s.io images tag --force "$1" "$2" > /dev/null
  fi
  $ctr -n k8s.io images push --plain-http "$2" "$2" > /dev/null
}

if [ "$1" = push ]; then
  push_to_registry "$2" "$3"
  exit 0
fi

runtime=$1
platform=$2
tag=$3
ref=$4
registry_ref=${5:-}
root=${VC_DELTA_ROOT:-/var/lib/vibecarbon/delta}

mkdir -p "$root"
# A host power loss or an OOM kill never runs the EXIT trap below: sweep work
# dirs an hour old (no delivery runs that long) so they cannot pile up.
find "$root" -mindepth 1 -maxdepth 1 -name 'd.*' -mmin +60 -exec rm -rf {} \;
d=$(mktemp -d "$root/d.XXXXXX")
# Every exit removes the work dir: a load that fails, a killed transfer, a
# signal. Nothing is tagged before the load succeeds and the check passes, so
# the next deploy starts clean.
trap 'rm -rf "$d"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 141' PIPE
trap 'exit 143' TERM

die() {
  echo "$*" >&2
  exit 1
}

# JSON on one line, whitespace dropped (docker pretty-prints some files).
flat() { tr -d ' \t\r\n' < "$1"; }
# The values of a flat JSON string array `"<key>":[...]`, one per line. The
# echo ends the last line (sed copies a missing final newline as missing).
json_list() {
  { sed -n "s/.*\"$1\":\[\([^]]*\)].*/\1/p"; echo; } | tr ',' '\n' | tr -d '"' | sed '/^$/d'
}
# The value of a flat JSON string `"<key>":"..."`.
json_str() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

# Runs "$@" with stdout into tar -x -C <dir>, failing when either side fails
# (POSIX sh has no pipefail: an empty `docker save` must not look like success).
save_into() {
  dir=$1
  shift
  mkdir -p "$dir"
  { "$@" || echo $? > "$dir.rc"; } | tar -x -C "$dir"
  [ ! -f "$dir.rc" ] || die "$* failed (exit $(cat "$dir.rc"))"
}

img=$d/img
mkdir "$img"
tar -x -C "$img"
[ -f "$img/manifest.json" ] && [ -f "$img/config.json" ] && [ -f "$img/fill.txt" ] ||
  die "the image delta arrived incomplete"

if [ "$runtime" = k3s ]; then
  # The content store holds each layer blob by its own digest; ctr verifies it.
  while read -r i _diff src; do
    $ctr -n k8s.io content get "$src" > "$img/l$i" < /dev/null
  done < "$img/fill.txt"
else
  # Save each source image once, then pair ITS manifest Layers[j] with ITS
  # config diff_ids[j]: a containerd-store save names gzip layers by their
  # compressed digest, so the file name says nothing about the diffID.
  n=0
  for src in $(cut -d' ' -f3 "$img/fill.txt" | sort -u); do
    n=$((n + 1))
    s=$d/src$n
    save_into "$s" docker save --platform "$platform" "$src"
    flat "$s/manifest.json" > "$s.manifest"
    cfg=$(json_str Config < "$s.manifest")
    [ -n "$cfg" ] && [ -f "$s/$cfg" ] || die "the save of $src has no config"
    json_list Layers < "$s.manifest" > "$s.layers"
    flat "$s/$cfg" | json_list diff_ids > "$s.diffs"
    [ "$(wc -l < "$s.layers")" -eq "$(wc -l < "$s.diffs")" ] ||
      die "the save of $src pairs $(wc -l < "$s.layers") layers with $(wc -l < "$s.diffs") diffIDs"
    paste -d' ' "$s.diffs" "$s.layers" > "$s.pairs"
    while read -r i diff from; do
      [ "$from" = "$src" ] || continue
      p=$(awk -v d="$diff" '$1 == d { print $2; exit }' "$s.pairs")
      [ -n "$p" ] || die "image $src does not hold layer $diff"
      ln "$s/$p" "$img/l$i"
    done < "$img/fill.txt"
  done
fi

want=$(flat "$img/config.json" | json_list diff_ids | tr '\n' ' ')
layers=$(flat "$img/manifest.json" | json_list Layers | tr '\n' ' ')

# Load exactly what the manifest names; fill.txt stays behind.
load() {
  # shellcheck disable=SC2086 # $layers is a list of l<N> names
  { (cd "$img" && tar -cf - manifest.json config.json $layers) || echo $? > "$d/tar.rc"; } | "$@" > /dev/null
  [ ! -f "$d/tar.rc" ] || die "packing the image for load failed"
}

if [ "$runtime" = k3s ]; then
  load $ctr -n k8s.io images import -
  digest=$($ctr -n k8s.io images ls | awk -v r="$ref" '$1 == r { print $3; exit }')
  [ -n "$digest" ] || die "the import did not create $ref"
  cfg=$($ctr -n k8s.io content get "$digest" | tr -d ' \t\r\n' |
    sed -n 's/.*"config":{\([^}]*\)}.*/\1/p' | json_str digest)
  got=""
  [ -z "$cfg" ] || got=$($ctr -n k8s.io content get "$cfg" | tr -d ' \t\r\n' | json_list diff_ids | tr '\n' ' ')
  if [ "$got" != "$want" ]; then
    $ctr -n k8s.io images rm "$ref" > /dev/null 2>&1 || true
    die "the imported layers of $ref do not match the delta manifest"
  fi
  if [ -n "$registry_ref" ]; then
    push_to_registry "$ref" "$registry_ref"
  fi
else
  load docker load
  got=$(docker image inspect --format '{{range .RootFS.Layers}}{{.}} {{end}}' "$tag")
  if [ "$got" != "$want" ]; then
    docker image rm "$tag" > /dev/null 2>&1 || true
    die "the loaded layers of $tag do not match the delta manifest"
  fi
fi
