# Vendored protos — cluster-autoscaler `externalgrpc` (CA 1.32.7)

These `.proto` files are vendored, not generated. They define the wire contract for the
`clusterautoscaler.cloudprovider.v1.externalgrpc.CloudProvider` gRPC service that
cluster-autoscaler talks to when run with `--cloud-provider=externalgrpc`.

**Pinned upstream tag: `cluster-autoscaler-1.32.7`** of `github.com/kubernetes/autoscaler`.

At this tag, `NodeGroupTemplateNodeInfoResponse` embeds the k8s Node as a proto message
(`k8s.io.api.core.v1.Node nodeInfo = 1;`) rather than the `bytes nodeBytes` field used from
CA 1.35+. That embedding is why this vendor tree needs the full k8s `generated.proto` import
closure, not just `externalgrpc.proto`.

## DO NOT EDIT field numbers or message/field definitions

Every field number below is part of the wire contract cluster-autoscaler (Go, gogo-protobuf)
uses to talk to this service. Renumbering or removing a field breaks wire compatibility with
real CA binaries silently (protobuf just deserializes the wrong thing). If a re-vendor changes
a field number, that is upstream's decision to record, not ours to "fix".

The only edits permitted to these files are import **path** adjustments needed to resolve
against `src/autoscaler/protos/` as the single `includeDirs` root — never message content.
**No such adjustment was needed for this vendor**: every `import "..."` line in every file
below already resolves as a path relative to this directory, because the k8s repos
(`kubernetes/api`, `kubernetes/apimachinery`) already lay out their protos under a `k8s.io/...`
prefix that matches the Go import path used in `externalgrpc.proto`.

## Files and exact sources

| File | Source | Tag/ref | Verified sha256 |
|---|---|---|---|
| `externalgrpc.proto` | `kubernetes/autoscaler`, `cluster-autoscaler/cloudprovider/externalgrpc/protos/externalgrpc.proto` | `cluster-autoscaler-1.32.7` | `ddd1809b504c233e564282646aa060f2491360c31de9f4fc8d95a4a1339d3be1` |
| `k8s.io/api/core/v1/generated.proto` | `kubernetes/api`, `core/v1/generated.proto` | `kubernetes-1.32.12` | `dd6cf89d7df51a09d62b9c57f645c90956195df301c3c62d204b569821599502` |
| `k8s.io/apimachinery/pkg/apis/meta/v1/generated.proto` | `kubernetes/apimachinery`, `pkg/apis/meta/v1/generated.proto` | `kubernetes-1.32.12` | `ffc98d709e9d139e60460ee7a4fd526baf3baf1176a51859a7ba092eb26875cc` |
| `k8s.io/apimachinery/pkg/api/resource/generated.proto` | `kubernetes/apimachinery`, `pkg/api/resource/generated.proto` | `kubernetes-1.32.12` | `b952ca7037ea1fef76285a8b20597da7b18f2f789662dcf87717304da58a53b3` |
| `k8s.io/apimachinery/pkg/runtime/generated.proto` | `kubernetes/apimachinery`, `pkg/runtime/generated.proto` | `kubernetes-1.32.12` | `19a098984ebde051f717387ef35ae0069104eab9c0534a4bb37470ea1d47fcc9` |
| `k8s.io/apimachinery/pkg/runtime/schema/generated.proto` | `kubernetes/apimachinery`, `pkg/runtime/schema/generated.proto` | `kubernetes-1.32.12` | `f6c8cc582d36e639e022c9edc2faf213ab16fe07045fabf54f5edc2241eda3e5` |
| `k8s.io/apimachinery/pkg/util/intstr/generated.proto` | `kubernetes/apimachinery`, `pkg/util/intstr/generated.proto` | `kubernetes-1.32.12` | `7988d488df2aa72bc5fb7de6094e372f5aef03d7d70819ba777a8e8760dd9091` |

Fetched via `raw.githubusercontent.com/<repo>/<tag>/<path>`, e.g.:

```
https://raw.githubusercontent.com/kubernetes/autoscaler/cluster-autoscaler-1.32.7/cluster-autoscaler/cloudprovider/externalgrpc/protos/externalgrpc.proto
https://raw.githubusercontent.com/kubernetes/api/kubernetes-1.32.12/core/v1/generated.proto
https://raw.githubusercontent.com/kubernetes/apimachinery/kubernetes-1.32.12/pkg/apis/meta/v1/generated.proto
```

### Why `kubernetes-1.32.12` for the k8s files, not `kubernetes-1.32.0`

`cluster-autoscaler-1.32.7`'s `cluster-autoscaler/go.mod` pins:

```
k8s.io/api           v0.32.12
k8s.io/apimachinery  v0.32.12
```

`k8s.io/api` and `k8s.io/apimachinery` are published from the `kubernetes/api` and
`kubernetes/apimachinery` staging repos with tags of the form `kubernetes-1.<minor>.<patch>`
that correspond 1:1 to their Go module version `v0.<minor>.<patch>`. So `v0.32.12` ==
tag `kubernetes-1.32.12`. Using the exact patch tag (not just the `.0` tag) matches exactly
what CA 1.32.7 was built and tested against, in case any patch release touched these
generated protos.

The `cluster-autoscaler` repo's own `cluster-autoscaler/vendor/k8s.io/...` copies of these
files were tried first (per the task brief's fallback instruction) and returned 404 at this
tag — `vendor/` is not checked into that repo at `cluster-autoscaler-1.32.7`. Hence the
fallback to `k8s.io/api` + `k8s.io/apimachinery` directly, as instructed.

### Import closure

Confirmed by inspecting every `import "..."` line in all 7 files (no other `.proto` file is
pulled in transitively):

```
externalgrpc.proto
  -> google/protobuf/descriptor.proto      (bundled by protobufjs/proto-loader — not vendored)
  -> google/protobuf/any.proto             (bundled by protobufjs/proto-loader — not vendored)
  -> k8s.io/apimachinery/pkg/apis/meta/v1/generated.proto
  -> k8s.io/api/core/v1/generated.proto

k8s.io/apimachinery/pkg/apis/meta/v1/generated.proto
  -> k8s.io/apimachinery/pkg/runtime/generated.proto
  -> k8s.io/apimachinery/pkg/runtime/schema/generated.proto

k8s.io/api/core/v1/generated.proto
  -> k8s.io/apimachinery/pkg/api/resource/generated.proto
  -> k8s.io/apimachinery/pkg/apis/meta/v1/generated.proto
  -> k8s.io/apimachinery/pkg/runtime/generated.proto
  -> k8s.io/apimachinery/pkg/runtime/schema/generated.proto
  -> k8s.io/apimachinery/pkg/util/intstr/generated.proto

k8s.io/apimachinery/pkg/runtime/generated.proto        -> (no imports)
k8s.io/apimachinery/pkg/runtime/schema/generated.proto -> (no imports)
k8s.io/apimachinery/pkg/api/resource/generated.proto   -> (no imports)
k8s.io/apimachinery/pkg/util/intstr/generated.proto    -> (no imports)
```

`google/protobuf/any.proto` and `google/protobuf/descriptor.proto` are **not** vendored here:
`@grpc/proto-loader` (via `protobufjs`) bundles the standard `google/protobuf/*` well-known
types internally and resolves them without touching `includeDirs`. This was verified
empirically — `tests/unit/autoscaler/proto.test.ts` loads and exercises the full service
definition with only the 7 files in this directory present.

`// +protobuf.options.(gogoproto...)` lines seen in the k8s files are comment annotations
consumed by Kubernetes' Go code generator, not real `.proto` imports — no `gogo.proto` file
is required.

## `grpc/health/v1/health.proto` — separate pin, separate purpose

Task 5 (`server.js`) serves the standard gRPC health-checking protocol
(`grpc.health.v1.Health`) alongside `CloudProvider`, for `healthcheck.js`'s
exec probe. This file is unrelated to the `externalgrpc` wire contract above
(different upstream repo, different package, no imports of its own) — it's
vendored here rather than added as an npm dependency (e.g. `grpc-health-check`)
because `@grpc/proto-loader` is already a project dependency and this is a
30-line, self-contained, standards-stable file.

| File | Source | Tag/ref | Verified sha256 |
|---|---|---|---|
| `grpc/health/v1/health.proto` | `grpc/grpc`, `src/proto/grpc/health/v1/health.proto` | `v1.82.1` | `8d44f54645557c1e10ba0da377883fd4d24ad994aff4f2139d61b7e9f0ece511` |

Fetched via `https://raw.githubusercontent.com/grpc/grpc/v1.82.1/src/proto/grpc/health/v1/health.proto`
(diffed byte-identical against the `master`-branch copy at fetch time — this file has been
stable for years). No imports; loads standalone with the same `protoLoader.loadSync(...,
{ keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs:
[PROTO_DIR] })` options as `externalgrpc.proto`.

## Re-vendor procedure

To re-vendor at a new CA tag `cluster-autoscaler-X.Y.Z`:

1. Fetch `externalgrpc.proto` from
   `cluster-autoscaler/cloudprovider/externalgrpc/protos/externalgrpc.proto` at that tag.
2. Read its `import "k8s.io/..."` lines (if any — CA >= 1.35 drops them, see the M2 dossier
   §3 for the version-shape table) and that tag's `cluster-autoscaler/go.mod` for the exact
   `k8s.io/api` / `k8s.io/apimachinery` versions.
3. Fetch each required `generated.proto` from `kubernetes/api` / `kubernetes/apimachinery` at
   the matching `kubernetes-<version>` tag (try `cluster-autoscaler/vendor/k8s.io/...` inside
   the autoscaler repo first — use it if present, since it's guaranteed consistent).
4. Recursively follow each new file's own `import` lines until closed (none of the current
   6 k8s files import anything outside this closure or `google/protobuf/*`).
5. Diff every file against the previous vendor. Confirm no message/field/field-number was
   altered from what CA's Go client actually sends/expects at the new tag — a real shape
   change (e.g. `nodeInfo` -> `nodeBytes` at 1.35) is expected and must be reflected end-to-end
   in `src/autoscaler/proto.js` callers, not silently absorbed here.
6. Re-run `pnpm vitest run tests/unit/autoscaler/proto.test.ts` and update its assertions to
   match the new contract shape if it changed.
7. Update this file's table (sources, tag, sha256) and this section's CA tag pin.
