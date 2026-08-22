import { Client } from 'pg';
import { env } from '../src/server/lib/env';

/**
 * CI/CD Security Check
 * Verifies that Row Level Security (RLS) is enabled on ALL tables in the 'public' schema.
 * 
 * This ensures that no table is accidentally left open to public access 
 * (especially now that we rely on RLS as the primary defense mechanism).
 */

async function main() {
    console.log('🔒 Verifying Row Level Security (RLS) policies...');

    // Use connection string from env or default to local dev
    const connectionString =
        process.env.DATABASE_URL ||
        `postgres://postgres:${process.env.POSTGRES_PASSWORD || 'postgres'}@localhost:5432/postgres`;

    const client = new Client({ connectionString });

    try {
        await client.connect();

        // Query finding tables in public schema that have RLS disabled
        const result = await client.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
      AND rowsecurity = false;
    `);

        if (result.rows.length > 0) {
            console.error('\n❌ CRITICAL SECURITY FAILURE: The following tables do not have RLS enabled:');
            result.rows.forEach(row => {
                console.error(`   - ${row.tablename}`);
            });
            console.error('\nResult: Security check FAILED. All public tables must have RLS enabled.');
            process.exit(1);
        }

        console.log('✅ Success: All tables in public schema have RLS enabled.');
        process.exit(0);

    } catch (err) {
        console.error('Error running security check:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
