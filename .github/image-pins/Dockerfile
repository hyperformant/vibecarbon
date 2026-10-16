# syntax=docker/dockerfile:1
# NEVER BUILT. This file exists so Dependabot can see the image pins that live
# in JavaScript constants, which no Dependabot ecosystem parses. Each FROM line
# is byte-identical to one constant; tests/unit/deploy/image-digest-census.test.ts
# fails when they differ, in either direction.
#
# When Dependabot bumps a line here, its PR goes red until the matching
# constant carries the same ref. Copy it across in that PR:
#
#   socat      SOCAT_IMAGE              src/lib/deploy/compose/ha.js
#                                        (and carbon/k8s/base/repl-gateway/repl-gateway.yaml)
#   registry   REGISTRY_IMAGE           src/lib/deploy/compose/registry-config.js
#   busybox    DIAG_BUSYBOX_IMAGE       src/lib/images.js
#   netshoot   DIAG_NETSHOOT_IMAGE      src/lib/images.js
#   csi-init   CSI_UPSTREAM_IMAGE_PINS  src/lib/images.js (DO automount-udev-deleter)
#   binfmt     BINFMT_IMAGE             src/lib/deploy/platform.js (operator hint)
#
# This is the ONLY Dependabot entry that bumps alpine/socat and registry:
# every other entry ignores them, because their k8s copies
# (carbon/k8s/base/repl-gateway, carbon/k8s/base/registry) must equal the JS
# constant (census parity). Update those manifests in the same PR too.
#
# Not here, by design: the registry.k8s.io mirrors (MirroredImage.digest in
# src/lib/images.js) are re-pinned when a CSI or cluster-autoscaler version
# moves, and publish-images.yml fails a mirror leg whose upstream tag no
# longer resolves to the pinned digest. Our own images (db, carbon-autoscaler)
# are tag-pinned by revision; see the census allowlist for why.
FROM alpine/socat:1.8.1.3@sha256:fb3862c949af7c79996d0e514ee96128644d840835ed5368eeecb14a869de361 AS socat
FROM registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 AS registry
FROM busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662 AS busybox
FROM nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70 AS netshoot
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS csi-init
FROM tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 AS binfmt
