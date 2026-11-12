/**
 * A fake cloud for the Pulumi-engine tests in tests/integration/iac/, kept in
 * the JSON file named by FAKECLOUD_FILE.
 *
 * fakecloud:index:Server (server-state-follows-scale.test.ts) behaves like the
 * bridged providers where it matters:
 *   - read of a server that is gone returns nothing (refresh drops it);
 *   - read never returns userData: the last known value is kept. The cloud
 *     file records the user data a server was created with (`bootedWith`),
 *     as a real server keeps what it booted with whatever the state says
 *     later (k3s-token-derived.test.ts reads it);
 *   - a changed userData replaces the server, a changed size updates it. The
 *     engine hands a provider that accepts secrets a secret value wrapped, a
 *     new object on every call, so userData is compared by its value, as the
 *     bridged providers do: sealing it is not a change.
 *
 * The other types (retired-resources-surgery.test.ts) are plain records under
 * `things[<type>][<id>]`: read returns the stored inputs, any input change is
 * an update. Two of them model DigitalOcean's reserved IP and its assignment:
 *   - fakecloud:index:ReservedIp gets an address for an id;
 *   - fakecloud:index:ReservedIpAssignment records `assignedTo` on its IP
 *     when created and clears it when deleted, so a test can see whether
 *     Pulumi ever unassigned the address. Reading or deleting one whose IP
 *     is gone (released by address, outside Pulumi) fails with a 404, as
 *     DigitalOcean's API answers for an address no longer on the account:
 *     the stack that still lists it can then neither refresh nor destroy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as provider from '@pulumi/pulumi/provider/index.js';
import * as rpc from '@pulumi/pulumi/runtime/rpc.js';

const file = process.env.FAKECLOUD_FILE;
const load = () => {
  const cloud = JSON.parse(readFileSync(file, 'utf-8'));
  cloud.servers ??= {};
  cloud.things ??= {};
  return cloud;
};
const save = (cloud) => writeFileSync(file, JSON.stringify(cloud));

const SERVER = 'fakecloud:index:Server';
const RESERVED_IP = 'fakecloud:index:ReservedIp';
const ASSIGNMENT = 'fakecloud:index:ReservedIpAssignment';

/** A property value without the wrapper the engine puts on a secret. */
const revealed = (value) =>
  value && typeof value === 'object' && value[rpc.specialSigKey] === rpc.specialSecretSig
    ? revealed(value.value)
    : value;

/** The type token of `urn:pulumi:<stack>::<project>::<parent$>type::name`. */
const typeOf = (urn) => String(urn).split('::')[2].split('$').pop();
const thingsOf = (cloud, type) => {
  cloud.things[type] ??= {};
  return cloud.things[type];
};

/** The reserved IP an assignment names, or DigitalOcean's 404 for one released. */
const ipOrNotFound = (cloud, assignment) => {
  const ip = thingsOf(cloud, RESERVED_IP)[assignment.ipAddress];
  if (!ip) {
    throw new Error(
      `GET /v2/reserved_ips/${assignment.ipAddress}: 404 The resource you were accessing could not be found.`,
    );
  }
  return ip;
};

const fakecloud = {
  version: '0.0.1',
  async check(_urn, _olds, news) {
    return { inputs: news };
  },
  async diff(_id, urn, olds, news) {
    if (typeOf(urn) === SERVER) {
      const replaces =
        JSON.stringify(revealed(olds.userData)) !== JSON.stringify(revealed(news.userData))
          ? ['userData']
          : [];
      return { changes: replaces.length > 0 || olds.size !== news.size, replaces };
    }
    const keys = new Set([...Object.keys(olds ?? {}), ...Object.keys(news ?? {})]);
    const changed = [...keys].filter(
      (k) => k !== '__defaults' && JSON.stringify(olds?.[k]) !== JSON.stringify(news?.[k]),
    );
    return { changes: changed.length > 0, replaces: typeOf(urn) === ASSIGNMENT ? changed : [] };
  },
  async create(urn, inputs) {
    const cloud = load();
    const n = cloud.next++;
    const type = typeOf(urn);
    if (type === SERVER) {
      const id = String(n);
      cloud.servers[id] = {
        size: inputs.size,
        ip: `10.0.0.${id}`,
        bootedWith: revealed(inputs.userData),
      };
      save(cloud);
      return { id, outs: { ...inputs, ip: cloud.servers[id].ip } };
    }
    let id = String(n);
    let outs = { ...inputs };
    if (type === RESERVED_IP) {
      id = `203.0.113.${n}`;
      outs = { ...inputs, ipAddress: id };
    }
    if (type === ASSIGNMENT) {
      const ip = thingsOf(cloud, RESERVED_IP)[inputs.ipAddress];
      if (!ip) throw new Error(`no reserved IP ${inputs.ipAddress}`);
      ip.assignedTo = inputs.serverId;
      id = `${inputs.ipAddress}-${inputs.serverId}`;
    }
    thingsOf(cloud, type)[id] = outs;
    save(cloud);
    return { id, outs };
  },
  async read(id, urn, props) {
    const cloud = load();
    const type = typeOf(urn);
    if (type === SERVER) {
      const live = cloud.servers[id];
      if (!live) return {};
      const outs = { ...props, size: live.size, ip: live.ip };
      return { id, props: outs, inputs: { size: live.size, userData: props?.userData } };
    }
    const live = thingsOf(cloud, type)[id];
    if (!live) return {};
    if (type === ASSIGNMENT) ipOrNotFound(cloud, live);
    const { assignedTo: _assignedTo, ...stored } = live;
    const inputs = { ...stored };
    if (type === RESERVED_IP) delete inputs.ipAddress;
    return { id, props: { ...props, ...stored }, inputs };
  },
  async update(id, urn, _olds, news) {
    const cloud = load();
    const type = typeOf(urn);
    if (type === SERVER) {
      cloud.servers[id].size = news.size;
      save(cloud);
      return { outs: { ...news, ip: cloud.servers[id].ip } };
    }
    const things = thingsOf(cloud, type);
    things[id] = { ...things[id], ...news };
    save(cloud);
    return { outs: things[id] };
  },
  async delete(id, urn) {
    const cloud = load();
    const type = typeOf(urn);
    if (type === SERVER) {
      delete cloud.servers[id];
    } else {
      if (type === ASSIGNMENT) {
        const assignment = thingsOf(cloud, ASSIGNMENT)[id];
        if (assignment) ipOrNotFound(cloud, assignment).assignedTo = null;
      }
      delete thingsOf(cloud, type)[id];
    }
    save(cloud);
  },
};

provider.main(fakecloud, process.argv.slice(2));
