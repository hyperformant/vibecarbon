# syntax=docker/dockerfile:1
# NEVER BUILT. This file exists so Dependabot can see the image pins that live
# in JavaScript constants, which no Dependabot ecosystem parses. Each FROM line
# is byte-identical to one constant; tests/unit/deploy/image-digest-census.test.ts
# fails when they differ, in either direction.
#
# When Dependabot bumps a line here, its PR goes red until the matching
# constant carries the same ref. Copy it across in that PR:
#
#   busybox    DIAG_BUSYBOX_IMAGE       src/lib/images.js
#   netshoot   DIAG_NETSHOOT_IMAGE      src/lib/images.js
#   binfmt     BINFMT_IMAGE             src/lib/deploy/platform.js (operator hint)
#
# Not here, by design: every image we MIRROR into ghcr (MirroredImage entries
# in src/lib/images.js: the registry.k8s.io set, and since the cold-deploy-speed
# plan's Task 7 the core-path Docker Hub set, socat, registry and the DO CSI
# alpine included). Their refs point at our mirror and pin upstream's amd64
# child digest, which no Dependabot ecosystem can propose; they are re-pinned
# by hand, publish-images.yml fails a mirror leg whose upstream tag no longer
# resolves to the pin, and its weekly mirror-upstream-drift job lists newer
# upstream tags. Our own images (db, carbon-autoscaler, node-runtime) are
# tag-pinned by revision; see the census allowlist for why.
FROM busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662 AS busybox
FROM nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70 AS netshoot
FROM tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 AS binfmt
