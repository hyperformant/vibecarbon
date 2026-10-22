/**
 * Issuer names shared by the free TLS snapshot code and the k8s-ha engine.
 * An import-free leaf so neither side reaches into the other's internals.
 */

/** The local, contention-free issuer a pilot-standby's Certificates use. */
export const STANDBY_SELFSIGNED_ISSUER = 'vibecarbon-standby-selfsigned';
