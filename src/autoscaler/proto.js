import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

export const PROTO_DIR = join(dirname(fileURLToPath(import.meta.url)), 'protos');

/**
 * Load the vendored externalgrpc proto (cluster-autoscaler-1.32.7 contract).
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
