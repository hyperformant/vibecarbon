/**
 * A stand-in for a Pulumi provider SDK in unit tests: every resource class
 * records its constructor args into `created`, and every output property is
 * an inert value whose `.apply()` returns another one. Namespaced SDKs
 * (`scaleway.instance.Server`) resolve through nested namespaces.
 */
export type Created = Array<{ type: string; name: string; args: unknown }>;

type Output = { apply: () => Output };
const output = (): Output => ({ apply: () => output() });

function resourceClass(type: string, created: Created) {
  return class {
    constructor(name: string, args: unknown) {
      created.push({ type, name, args });
      // biome-ignore lint/correctness/noConstructorReturn: the inert resource stands in for Pulumi's
      return new Proxy(this, {
        get: (_target, prop) => (prop === 'then' ? undefined : output()),
      });
    }
  };
}

// biome-ignore lint/suspicious/noExplicitAny: an SDK namespace of any shape
function namespace(path: string, created: Created): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop === 'then' || prop === '__esModule') return undefined;
        if (/^[A-Z]/.test(prop)) return resourceClass(`${path}.${prop}`, created);
        return namespace(`${path}.${prop}`, created);
      },
    },
  );
}

/**
 * The module object for `vi.mock('<sdk>', () => recorderModule(...))`. ESM
 * namespaces need explicit keys, so the classes and namespaces the compose
 * programs use are listed.
 */
export function recorderModule(prefix: string, created: Created) {
  const root = namespace(prefix, created);
  const names = [
    'Firewall',
    'FirewallGroup',
    'FirewallRule',
    'Server',
    'Droplet',
    'Instance',
    'SshKey',
    'SSHKey',
    'instance',
    'iam',
  ];
  return Object.fromEntries([['default', root], ...names.map((n) => [n, root[n]])]);
}
