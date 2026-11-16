import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { logger } from './logger';
import { isKubernetes } from './runtime-env';

// Load k8s service account credentials once at startup
export const k8sCredentials = (() => {
  if (!isKubernetes) return null;
  try {
    return {
      token: fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim(),
      ca: fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
      namespace: fs
        .readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8')
        .trim(),
    };
  } catch {
    return null;
  }
})();

/** Read the pod's default gateway from /proc/net/route (little-endian hex) */
function getPodDefaultGateway(): string | null {
  try {
    const routes = fs.readFileSync('/proc/net/route', 'utf8');
    for (const line of routes.split('\n').slice(1)) {
      const parts = line.split('\t');
      if (parts[1] === '00000000' && parts[2] && parts[2] !== '00000000') {
        const h = parts[2];
        return [
          parseInt(h.slice(6, 8), 16),
          parseInt(h.slice(4, 6), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(0, 2), 16),
        ].join('.');
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function testTcpConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.connect(port, host, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// Lazily detected API server endpoint (ClusterIP or pod gateway fallback)
let k8sApiEndpoint: { host: string; port: number } | null | undefined;

async function getK8sApiEndpoint(): Promise<{ host: string; port: number } | null> {
  if (k8sApiEndpoint !== undefined) return k8sApiEndpoint;

  const clusterIpHost = process.env.KUBERNETES_SERVICE_HOST ?? '';
  const clusterIpPort =
    Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT) || 443;

  // Try ClusterIP first (works on worker nodes via kube-proxy DNAT)
  if (clusterIpHost && (await testTcpConnection(clusterIpHost, clusterIpPort))) {
    k8sApiEndpoint = { host: clusterIpHost, port: clusterIpPort };
    return k8sApiEndpoint;
  }

  // Fall back to pod gateway on port 6443 (k3s master: kube-proxy doesn't install
  // KUBE-SERVICES rules for the kubernetes ClusterIP on the master node itself)
  const gateway = getPodDefaultGateway();
  if (gateway && (await testTcpConnection(gateway, 6443))) {
    logger.info({ gateway }, 'K8s API: using pod gateway fallback (k3s master node)');
    k8sApiEndpoint = { host: gateway, port: 6443 };
    return k8sApiEndpoint;
  }

  k8sApiEndpoint = null;
  return null;
}

async function k8sRequestWithStatus(
  path: string,
  acceptText = false
): Promise<{ status: number; body: string }> {
  const creds = k8sCredentials;
  if (!creds) throw new Error('K8s credentials not available');

  const endpoint = await getK8sApiEndpoint();
  if (!endpoint) throw new Error('K8s API server not reachable');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: endpoint.host,
        port: endpoint.port,
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: acceptText ? 'text/plain' : 'application/json',
        },
        ca: creds.ca,
        // Verification stays ON for every endpoint. It used to be
        //   rejectUnauthorized: endpoint.host === (process.env.KUBERNETES_SERVICE_HOST ?? '')
        // which disabled it entirely on the gateway:6443 fallback — and, when
        // KUBERNETES_SERVICE_HOST was unset, compared against '' and so
        // disabled it for EVERY request. This call carries the pod's
        // ServiceAccount token in an Authorization header, so anything able to
        // intercept pod->node:6443 could harvest cluster credentials.
        //
        // The real problem was never the CA — `creds.ca` is the cluster CA and
        // is already loaded here. It is only that the apiserver cert is issued
        // for the ClusterIP/master hostname, not for the gateway IP we dial on
        // the fallback. So keep the chain check and relax ONLY the hostname
        // match, by verifying against the in-cluster name instead of the dialed
        // address. Same shape as the CLI's staging-CA fix: pin the trust
        // anchor, never turn verification off.
        rejectUnauthorized: true,
        servername: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
        checkServerIdentity: (_host: string, cert: Parameters<typeof tls.checkServerIdentity>[1]) =>
          tls.checkServerIdentity('kubernetes.default.svc', cert),
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.setTimeout(30000, () => req.destroy(new Error('K8s API timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** GET a Kubernetes API path; the body comes back whatever the status. */
export async function k8sRequest(path: string, acceptText = false): Promise<string> {
  return (await k8sRequestWithStatus(path, acceptText)).body;
}

export class K8sApiError extends Error {
  readonly status: number;
  constructor(status: number, message = `K8s API returned ${status}`) {
    super(message);
    this.name = 'K8sApiError';
    this.status = status;
  }
}

/**
 * GET a JSON document from the Kubernetes API. Unlike k8sRequest, which
 * returns the body whatever the status, this rejects with K8sApiError on any
 * non-2xx (a 403 Forbidden body is valid JSON and must not read as data).
 */
export async function k8sGetJson<T>(path: string): Promise<T> {
  const { status, body } = await k8sRequestWithStatus(path);
  if (status < 200 || status > 299) throw new K8sApiError(status);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new K8sApiError(status, 'K8s API returned a body that is not JSON');
  }
}
