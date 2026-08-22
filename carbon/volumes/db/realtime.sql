-- Realtime Schema Setup
-- This sets up the required schema for Supabase Realtime

-- Create realtime schema
CREATE SCHEMA IF NOT EXISTS _realtime;

-- Grant permissions to postgres and supabase_admin (used by Realtime service)
GRANT USAGE ON SCHEMA _realtime TO postgres, supabase_admin;
GRANT ALL ON SCHEMA _realtime TO postgres, supabase_admin;

-- Create publication for realtime
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;
END
$$;

-- Function to enable realtime for a table
CREATE OR REPLACE FUNCTION _realtime.enable_table(table_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', table_name);
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION _realtime.enable_table(text) TO postgres, supabase_admin;
