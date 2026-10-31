/**
 * A fake cloud for tests/integration/iac/server-state-follows-scale.test.ts:
 * one resource type, fakecloud:index:Server, kept in the JSON file named by
 * FAKECLOUD_FILE. It behaves like the bridged providers where it matters:
 *   - read of a server that is gone returns nothing (refresh drops it);
 *   - read never returns userData: the last known value is kept;
 *   - a changed userData replaces the server, a changed size updates it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as provider from '@pulumi/pulumi/provider/index.js';

const file = process.env.FAKECLOUD_FILE;
const load = () => JSON.parse(readFileSync(file, 'utf-8'));
const save = (cloud) => writeFileSync(file, JSON.stringify(cloud));

const fakecloud = {
  version: '0.0.1',
  async check(_urn, _olds, news) {
    return { inputs: news };
  },
  async diff(_id, _urn, olds, news) {
    const replaces = olds.userData !== news.userData ? ['userData'] : [];
    return { changes: replaces.length > 0 || olds.size !== news.size, replaces };
  },
  async create(_urn, inputs) {
    const cloud = load();
    const id = String(cloud.next++);
    cloud.servers[id] = { size: inputs.size, ip: `10.0.0.${id}` };
    save(cloud);
    return { id, outs: { ...inputs, ip: cloud.servers[id].ip } };
  },
  async read(id, _urn, props) {
    const live = load().servers[id];
    if (!live) return {};
    const outs = { ...props, size: live.size, ip: live.ip };
    return { id, props: outs, inputs: { size: live.size, userData: props?.userData } };
  },
  async update(id, _urn, _olds, news) {
    const cloud = load();
    cloud.servers[id].size = news.size;
    save(cloud);
    return { outs: { ...news, ip: cloud.servers[id].ip } };
  },
  async delete(id) {
    const cloud = load();
    delete cloud.servers[id];
    save(cloud);
  },
};

provider.main(fakecloud, process.argv.slice(2));
