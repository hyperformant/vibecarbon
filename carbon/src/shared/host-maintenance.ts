/** One server's restart state, as the admin endpoint reports it. */
export type HostServer = {
  name: string;
  reporting: boolean;
  rebootRequired: boolean;
  since: string | null;
  packages: string[];
};

export type HostMaintenance = {
  runtime: 'compose' | 'kubernetes' | 'none';
  envName: string | null;
  rebootRequired: boolean;
  since: string | null;
  servers: HostServer[];
};
