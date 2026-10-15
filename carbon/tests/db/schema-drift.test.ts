import { getTableColumns, getTableName, isTable } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@server/db/schema';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * src/server/db/schema.ts mirrors db/migrations/ by hand. If a migration
 * renames or drops a column the Drizzle mirror still names, queries fail at
 * runtime; this catches it at test time instead. It also fails when a public
 * table has no Drizzle definition at all, so a new migration cannot ship a
 * table the server cannot query with types. Column types and nullability are
 * compared too: Better Auth writes the auth tables through this mirror, so a
 * `uuid` id or a NOT NULL default that only one side has breaks sign-up.
 */

interface ColumnInfo {
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}
describe.skipIf(!dbTestsEnabled)('Drizzle schema matches the migrated database', () => {
  let db: pg.Client;
  const actual = new Map<string, Set<string>>();
  const columnInfo = new Map<string, ColumnInfo>();

  const tables = Object.values(schema).filter((v): v is PgTable => isTable(v));

  beforeAll(async () => {
    db = await connectTestDb();
    const { rows } = await db.query<ColumnInfo & { table_name: string; column_name: string }>(
      `select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`,
    );
    for (const { table_name, column_name, ...info } of rows) {
      if (!actual.has(table_name)) actual.set(table_name, new Set());
      actual.get(table_name)?.add(column_name);
      columnInfo.set(`${table_name}.${column_name}`, info);
    }
  });

  afterAll(async () => {
    await db?.end();
  });

  it('defines at least one table', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it('every Drizzle table and column exists after migrations', () => {
    const missing: string[] = [];
    for (const table of tables) {
      const name = getTableName(table);
      const columns = actual.get(name);
      if (!columns) {
        missing.push(`${name} (table)`);
        continue;
      }
      for (const column of Object.values(getTableColumns(table))) {
        if (!columns.has(column.name)) missing.push(`${name}.${column.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every Drizzle column has the migrated type and nullability', () => {
    const mismatched: string[] = [];
    for (const table of tables) {
      const name = getTableName(table);
      for (const column of Object.values(getTableColumns(table))) {
        const info = columnInfo.get(`${name}.${column.name}`);
        if (!info) continue; // reported by the existence test above
        const want = { type: column.getSQLType(), notNull: column.notNull };
        const got = { type: info.data_type, notNull: info.is_nullable === 'NO' };
        if (want.type !== got.type || want.notNull !== got.notNull) {
          mismatched.push(`${name}.${column.name}: drizzle ${JSON.stringify(want)} db ${JSON.stringify(got)}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('auth table ids are uuids the database generates (Better Auth runs with generateId: false)', () => {
    for (const table of ['user', 'session', 'account', 'two_factor']) {
      const id = columnInfo.get(`${table}.id`);
      expect(id?.data_type, `${table}.id`).toBe('uuid');
      expect(id?.column_default, `${table}.id`).toMatch(/gen_random_uuid\(\)/);
    }
  });

  it('verification ids are text: Better Auth writes its own non-uuid ids there', () => {
    const id = columnInfo.get('verification.id');
    expect(id?.data_type).toBe('text');
    expect(id?.column_default).toMatch(/gen_random_uuid\(\)/);
  });

  it('every public table has a Drizzle definition with every column', () => {
    const defined = new Map(
      tables.map((t) => [
        getTableName(t),
        new Set(Object.values(getTableColumns(t)).map((c) => c.name)),
      ]),
    );
    const undefinedInDrizzle: string[] = [];
    for (const [name, columns] of actual) {
      const mirror = defined.get(name);
      if (!mirror) {
        undefinedInDrizzle.push(`${name} (table)`);
        continue;
      }
      for (const column of columns) {
        if (!mirror.has(column)) undefinedInDrizzle.push(`${name}.${column}`);
      }
    }
    expect(undefinedInDrizzle).toEqual([]);
  });
});
