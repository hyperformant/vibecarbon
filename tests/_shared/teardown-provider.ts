/**
 * A cloud provider instance for the tests that run destroy's real teardown
 * effects. Destroy reaches dozens of provider methods and each test cares
 * about a few, so the fake is a Proxy that answers any method by its name.
 * Eight destroy tests each wrote that Proxy out; they differed only in the
 * parts that are options here.
 *
 * What a property answers, first match wins:
 * - a symbol, or `then`: undefined, so awaiting the provider never hangs;
 * - `constructor`, when `ctor` is given: `ctor`, the fake's own function,
 *   whose statics (NAME, K8S_DESTROY_BACKSTOP, ...) destroy reads;
 * - an own key of `methods`: its value as given. Undefined there means the
 *   provider lacks that method, which destroy checks for;
 * - `serverNetworkIds` and `serverVolumeIds`, when `serverIdsEmpty`: a
 *   reader that answers [];
 * - a name `deleteVerbs` matches: an async method answering
 *   `deleted(name, ...args)`;
 * - a name starting `list`, `find` or `get`: an async method answering [];
 * - anything else: a method that does nothing.
 */
export function teardownProvider({
  ctor,
  methods = {},
  serverIdsEmpty = false,
  deleteVerbs = /^(delete|remove|destroy|detach|release)/,
  deleted,
}: {
  ctor?: unknown;
  methods?: Record<string, unknown>;
  serverIdsEmpty?: boolean;
  deleteVerbs?: RegExp;
  deleted: (method: string, ...args: unknown[]) => unknown;
}): object {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (ctor !== undefined && prop === 'constructor') return ctor;
        if (Object.hasOwn(methods, prop)) return methods[prop];
        if (serverIdsEmpty && /^(serverNetworkIds|serverVolumeIds)$/.test(prop)) return () => [];
        if (deleteVerbs.test(prop)) return async (...args: unknown[]) => deleted(prop, ...args);
        if (/^(list|find|get)/.test(prop)) return async () => [];
        return () => undefined;
      },
    },
  );
}
