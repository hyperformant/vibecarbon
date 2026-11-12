import * as pulumi from '@pulumi/pulumi';
import * as rpc from '@pulumi/pulumi/runtime/rpc.js';

/**
 * Reading a secret input back in a test. The programs wrap server user data in
 * `pulumi.secret`, so a test that inspects what a server boots with has to
 * look through the wrapper the way the engine does.
 */

/**
 * A resource input from `pulumi.runtime.setMocks` (`args.inputs`), with its
 * secret wrapper removed. Plain values pass through.
 */
export function unsealMockInput<T = unknown>(value: unknown): T {
  if (
    value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)[rpc.specialSigKey] === rpc.specialSecretSig
  ) {
    return (value as { value: T }).value;
  }
  return value as T;
}

/**
 * `value` with every Pulumi Output (secret or not) resolved, deeply, for
 * arguments a recorder (tests/_shared/pulumi-recorder.ts) captured.
 */
export async function resolveOutputs(value: unknown): Promise<unknown> {
  if (pulumi.Output.isInstance(value)) {
    const inner = await new Promise((resolve) =>
      (value as pulumi.Output<unknown>).apply((x) => {
        resolve(x);
        return x;
      }),
    );
    return resolveOutputs(inner);
  }
  if (Array.isArray(value)) return Promise.all(value.map(resolveOutputs));
  if (value && typeof value === 'object') {
    // A recorder output prints as `<name>.<property>`: keep it as it is.
    if (Object.keys(value).join() === 'apply,toString') return value;
    return Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveOutputs(v)])),
    );
  }
  return value;
}
