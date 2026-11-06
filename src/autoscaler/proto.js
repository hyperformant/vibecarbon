import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';

export const PROTO_DIR = join(dirname(fileURLToPath(import.meta.url)), 'protos');

/**
 * Load the vendored externalgrpc proto (cluster-autoscaler-1.37.0 contract).
 * keepCase is mandatory: handlers reference exact proto field names
 * (providerID, nodeInfo, instanceState, ...).
 */
export function loadExternalGrpcDefinition() {
  const def = protoLoader.loadSync(join(PROTO_DIR, 'externalgrpc.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  return grpc.loadPackageDefinition(def).clusterautoscaler.cloudprovider.v1.externalgrpc;
}

/**
 * The k8s `v1.Node` message type, for NodeGroupTemplateNodeInfo's `nodeBytes`.
 * From CA 1.35 externalgrpc no longer imports the k8s protos: it carries the
 * Node as bytes that CA hands straight to Go's `v1.Node.Unmarshal`, so they are
 * a bare Node message with no runtime.Unknown wrapper and no k8s magic prefix.
 * keepCase matches the vendored field names buildTemplateNode writes.
 *
 * @returns {import('protobufjs').Type}
 */
export function loadNodeType() {
  const root = new protobuf.Root();
  // Every import in the k8s files is a full `k8s.io/...` path, so it resolves
  // against PROTO_DIR, not relative to the importing file.
  root.resolvePath = (origin, target) =>
    target.startsWith('k8s.io/')
      ? join(PROTO_DIR, target)
      : protobuf.util.path.resolve(origin, target);
  root.loadSync(join(PROTO_DIR, 'k8s.io/api/core/v1/generated.proto'), { keepCase: true });
  return root.lookupType('k8s.io.api.core.v1.Node');
}
