import { getTableColumns, getTableName, isTable } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@server/db/schema';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * src/server/db/schema.ts mirrors supabase/migrations/ by hand. If a migration
 * renames or drops a column the Drizzle mirror still names, queries fail at
 * runtime; this catches it at test time instead. It also fails when a public
 * table has no Drizzle definition at all, so a new migration cannot ship a
 * table the server cannot query with types.
 */
describe.skipIf(!dbTestsEnabled)('Drizzle schema matches the migrated database', () => {
  let db: pg.Client;
  const actual = new Map<string, Set<string>>();

  const tables = Object.values(schema).filter((v): v is PgTable => isTable(v));

  beforeAll(async () => {
    db = await connectTestDb();
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `select c.table_name, c.column_name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`,
    );
    for (const { table_name, column_name } of rows) {
      if (!actual.has(table_name)) actual.set(table_name, new Set());
      actual.get(table_name)?.add(column_name);
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
