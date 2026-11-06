# Vendored protos — cluster-autoscaler `externalgrpc` (CA 1.37.0)

These `.proto` files are vendored, not generated. They define the wire contract for the
`clusterautoscaler.cloudprovider.v1.externalgrpc.CloudProvider` gRPC service that
cluster-autoscaler talks to when run with `--cloud-provider=externalgrpc`.

**Pinned upstream tag: `cluster-autoscaler-1.37.0`** of `github.com/kubernetes/autoscaler`.

At this tag, `NodeGroupTemplateNodeInfoResponse` carries the k8s Node as bytes
(`bytes nodeBytes = 2;`, the contract since CA 1.35): CA passes them straight to Go's
`v1.Node.Unmarshal`, so they are a bare Node message with no `runtime.Unknown` wrapper and no k8s
magic prefix. `externalgrpc.proto` itself no longer imports any k8s proto. The k8s
`generated.proto` closure stays vendored only so `loadNodeType` in `src/autoscaler/proto.js` can
encode that message.

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
| `externalgrpc.proto` | `kubernetes/autoscaler`, `cluster-autoscaler/cloudprovider/externalgrpc/protos/externalgrpc.proto` | `cluster-autoscaler-1.37.0` | `0071a1864ef3a6f2f47c354a60b71f685281169f13ddff22e885667a13015cb2` |
| `k8s.io/api/core/v1/generated.proto` | `kubernetes/api`, `core/v1/generated.proto` | `kubernetes-1.37.1` | `fa79488e86ac6e10eee7d15a5d7a98d4e7a28eaf213bb9791f69bddb6d7fb35d` |
| `k8s.io/apimachinery/pkg/apis/meta/v1/generated.proto` | `kubernetes/apimachinery`, `pkg/apis/meta/v1/generated.proto` | `kubernetes-1.37.1` | `852ca832d77f5c9281034f9f1ae3ae581dc77a069ee0c0f5db2832002655ee83` |
| `k8s.io/apimachinery/pkg/api/resource/generated.proto` | `kubernetes/apimachinery`, `pkg/api/resource/generated.proto` | `kubernetes-1.37.1` | `78274163443c9942fd5cfd41d2c0cb6d5bb06ff109f37c33be23147dcf63771a` |
| `k8s.io/apimachinery/pkg/runtime/generated.proto` | `kubernetes/apimachinery`, `pkg/runtime/generated.proto` | `kubernetes-1.37.1` | `65aaf6e591ce90732d184ff893c807cf54e2e6ef8640260837614ee5ccf2b329` |
| `k8s.io/apimachinery/pkg/runtime/schema/generated.proto` | `kubernetes/apimachinery`, `pkg/runtime/schema/generated.proto` | `kubernetes-1.37.1` | `f6c8cc582d36e639e022c9edc2faf213ab16fe07045fabf54f5edc2241eda3e5` |
| `k8s.io/apimachinery/pkg/util/intstr/generated.proto` | `kubernetes/apimachinery`, `pkg/util/intstr/generated.proto` | `kubernetes-1.37.1` | `3595eaaeb57a233568c50c9e16d81efa50238f63e9f7d8d00f18b188fa8fdcb2` |

Fetched via `raw.githubusercontent.com/<repo>/<tag>/<path>`, e.g.:

```
https://raw.githubusercontent.com/kubernetes/autoscaler/cluster-autoscaler-1.37.0/cluster-autoscaler/cloudprovider/externalgrpc/protos/externalgrpc.proto
https://raw.githubusercontent.com/kubernetes/api/kubernetes-1.37.1/core/v1/generated.proto
https://raw.githubusercontent.com/kubernetes/apimachinery/kubernetes-1.37.1/pkg/apis/meta/v1/generated.proto
```

### Why `kubernetes-1.37.1` for the k8s files, not `kubernetes-1.37.0`

`cluster-autoscaler-1.37.0`'s `cluster-autoscaler/go.mod` pins:

```
k8s.io/api           v0.37.1
k8s.io/apimachinery  v0.37.1
```

`k8s.io/api` and `k8s.io/apimachinery` are published from the `kubernetes/api` and
`kubernetes/apimachinery` staging repos with tags of the form `kubernetes-1.<minor>.<patch>`
that correspond 1:1 to their Go module version `v0.<minor>.<patch>`. So `v0.37.1` ==
tag `kubernetes-1.37.1`. Using the exact patch tag (not just the `.0` tag) matches exactly
what CA 1.37.0 was built and tested against, in case any patch release touched these
generated protos.

### Import closure

Confirmed by inspecting every `import "..."` line in all 7 files (no other `.proto` file is
pulled in transitively):

```
externalgrpc.proto
  -> google/protobuf/descriptor.proto      (bundled by protobufjs/proto-loader — not vendored)
  -> google/protobuf/any.proto             (bundled by protobufjs/proto-loader — not vendored)
  -> google/protobuf/timestamp.proto       (bundled by protobufjs/proto-loader — not vendored)
  -> google/protobuf/duration.proto        (bundled by protobufjs/proto-loader — not vendored)

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

The `google/protobuf/*` files are **not** vendored here: `@grpc/proto-loader` (via `protobufjs`)
bundles those well-known types and resolves them without touching `includeDirs`.
`tests/unit/autoscaler/proto.test.ts` loads and exercises the full service definition with only
the files in this directory present.

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
2. Read that tag's `cluster-autoscaler/go.mod` for the exact `k8s.io/api` /
   `k8s.io/apimachinery` versions.
3. Fetch each required `generated.proto` from `kubernetes/api` / `kubernetes/apimachinery` at
   the matching `kubernetes-<version>` tag.
4. Recursively follow each new file's own `import` lines until closed (none of the current
   6 k8s files import anything outside this closure or `google/protobuf/*`).
5. Diff every file against the previous vendor. Confirm no message/field/field-number was
   altered from what CA's Go client actually sends/expects at the new tag — a real shape
   change must be reflected end-to-end in `src/autoscaler/` callers, not silently absorbed here.
6. Re-run `pnpm vitest run tests/unit/autoscaler/proto.test.ts` and update its assertions to
   match the new contract shape if it changed.
7. Update this file's table (sources, tag, sha256) and this section's CA tag pin, and move
   `CARBON_AUTOSCALER_TAG`, since the image contents changed.
