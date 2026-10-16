/**
 * Where this app process runs, read once at startup. One definition shared
 * by every module that needs to know (the admin Infrastructure page, the
 * Traefik probe), so they can never disagree.
 *
 * - k8s: the kubelet sets KUBERNETES_SERVICE_HOST in every pod.
 * - Docker (compose): the production image runs with NODE_ENV=production;
 *   DOCKER=true marks any other containerised run.
 * - Neither: local dev, the app on the host and its services in Docker.
 */
export const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;
export const isDocker =
  !isKubernetes && (process.env.NODE_ENV === 'production' || process.env.DOCKER === 'true');
