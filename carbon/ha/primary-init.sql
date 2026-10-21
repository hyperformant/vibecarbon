-- Configure primary PostgreSQL for streaming replication.
-- Run on the primary database before initializing the standby.
--
-- This script is idempotent: safe to run multiple times.
--
-- SECURITY: `{{REPL_PASSWORD}}` below is a PLACEHOLDER, not a real password.
-- This file MUST be rendered with a real per-deploy password before running;
-- never run it raw. The vibecarbon deploy tooling renders it automatically
-- (src/lib/deploy/k8s/ha/index.js substitutes '{{REPL_PASSWORD}}' with the
-- random REPL_PASSWORD generated at create time). Running this file unrendered
-- would either fail (invalid SQL) or, if hand-edited, risk a weak-cred
-- `replicator` role — do not do it.

-- Create dedicated replication role (if not exists), or update its password on re-runs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '{{REPL_PASSWORD}}';
  ELSE
    ALTER ROLE replicator WITH PASSWORD '{{REPL_PASSWORD}}';
  END IF;
END $$;

-- Enable WAL-level replication
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET max_wal_senders = 5;
ALTER SYSTEM SET wal_keep_size = '512MB';

-- The physical replication slot for the standby. Without a slot, the
-- standby's follow position isn't persisted on primary; if it falls behind
-- by more than wal_keep_size, primary recycles WAL and streaming breaks
-- silently. The slot tells primary to hold WAL until the standby confirms
-- receipt, up to max_slot_wal_keep_size (the db argv). Past that cap the slot
-- goes lost and can never stream again, so a lost slot is dropped and
-- recreated here, on every HA deploy, ahead of the standby's reseed.
-- Generated from ensureReplicationSlotSql (src/lib/deploy/replication-slot.js);
-- tests/unit/deploy/slot-lost-reseed.test.ts keeps the two identical.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_replication_slots
    WHERE slot_name = 'vibecarbon_standby_slot' AND wal_status = 'lost'
  ) THEN
    PERFORM pg_drop_replication_slot('vibecarbon_standby_slot');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = 'vibecarbon_standby_slot'
  ) THEN
    PERFORM pg_create_physical_replication_slot('vibecarbon_standby_slot');
  END IF;
END $$;

-- Reload config (wal_level change requires restart, handled by caller)
SELECT pg_reload_conf();
