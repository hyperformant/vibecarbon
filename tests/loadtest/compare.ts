#!/usr/bin/env node
/**
 * Performance Result Comparison Tool
 *
 * Compares two saved result JSON files and prints a terminal table showing
 * latency p95 and RPS deltas. Exits with code 1 if --fail-on-regression is
 * passed and any endpoint regressed (>20% p95 increase).
 *
 * Usage:
 *   node --import tsx/esm tests/loadtest/compare.ts baseline.json candidate.json [--fail-on-regression]
 *
 * Importable:
 *   import { compare } from './compare.js';
 */

import { readFileSync } from 'node:fs';
import type { PerfRunFile, ScenarioResult } from './runner';

export const REGRESSION_THRESHOLD = 0.2; // 20% p95 increase

export type Status = 'STABLE' | 'IMPROVED' | 'REGRESSED';

export function load(filepath: string): PerfRunFile {
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8')) as PerfRunFile;
  } catch (err) {
    console.error(`Failed to read ${filepath}:`, err);
    process.exit(1);
  }
}

export function delta(before: number, after: number): string {
  if (before === 0) return 'N/A';
  const pct = ((after - before) / before) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export function endpointStatus(beforeP95: number, afterP95: number): Status {
  if (beforeP95 === 0) return 'STABLE';
  const change = (afterP95 - beforeP95) / beforeP95;
  if (change > REGRESSION_THRESHOLD) return 'REGRESSED';
  if (change < -0.05) return 'IMPROVED';
  return 'STABLE';
}

function pad(str: string, width: number): string {
  return str.padEnd(width).slice(0, width);
}

function rpad(str: string, width: number): string {
  return str.padStart(width).slice(-width);
}

/**
 * Compare two result files and print a table.
 * Returns true if any endpoint regressed.
 */
export function compare(baselinePath: string, candidatePath: string): boolean {
  const baseline = load(baselinePath);
  const candidate = load(candidatePath);

  console.log('\nPerformance Comparison');
  console.log('='.repeat(100));
  console.log(
    `Baseline:  ${baseline.meta.label} @ ${baseline.meta.timestamp} (${baseline.meta.baseUrl})`,
  );
  console.log(
    `Candidate: ${candidate.meta.label} @ ${candidate.meta.timestamp} (${candidate.meta.baseUrl})`,
  );
  console.log('='.repeat(100));

  const allEndpoints = new Set([
    ...Object.keys(baseline.results),
    ...Object.keys(candidate.results),
  ]);

  const COL_ENDPOINT = 32;
  const COL_NUM = 10;
  const COL_STATUS = 11;

  const header = [
    pad('Endpoint', COL_ENDPOINT),
    rpad('p95 before', COL_NUM),
    rpad('p95 after', COL_NUM),
    rpad('p95 Δ', COL_NUM),
    rpad('RPS before', COL_NUM),
    rpad('RPS after', COL_NUM),
    rpad('RPS Δ', COL_NUM),
    rpad('Errors Δ', COL_NUM),
    pad('Status', COL_STATUS),
  ].join('  ');

  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));

  let anyRegressed = false;

  for (const endpoint of allEndpoints) {
    const before: ScenarioResult | undefined = baseline.results[endpoint];
    const after: ScenarioResult | undefined = candidate.results[endpoint];

    if (!before || !after) {
      const note = !before ? '(new)' : '(removed)';
      console.log(`${pad(endpoint, COL_ENDPOINT)}  ${note}`);
      continue;
    }

    const s = endpointStatus(before.latency.p95, after.latency.p95);
    if (s === 'REGRESSED') anyRegressed = true;

    const statusColor =
      s === 'REGRESSED' ? `\x1b[31m${s}\x1b[0m` : s === 'IMPROVED' ? `\x1b[32m${s}\x1b[0m` : s;

    const row = [
      pad(endpoint, COL_ENDPOINT),
      rpad(`${before.latency.p95}ms`, COL_NUM),
      rpad(`${after.latency.p95}ms`, COL_NUM),
      rpad(delta(before.latency.p95, after.latency.p95), COL_NUM),
      rpad(before.rps.toFixed(1), COL_NUM),
      rpad(after.rps.toFixed(1), COL_NUM),
      rpad(delta(before.rps, after.rps), COL_NUM),
      rpad(
        `${after.errors - before.errors >= 0 ? '+' : ''}${after.errors - before.errors}`,
        COL_NUM,
      ),
      statusColor,
    ].join('  ');

    console.log(row);
  }

  console.log('-'.repeat(header.length));
  console.log(`\nRegression threshold: >${REGRESSION_THRESHOLD * 100}% p95 increase\n`);

  return anyRegressed;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const failOnRegression = args.includes('--fail-on-regression');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length !== 2) {
    console.error('Usage: compare.ts <baseline.json> <candidate.json> [--fail-on-regression]');
    process.exit(1);
  }

  const anyRegressed = compare(files[0], files[1]);

  if (failOnRegression && anyRegressed) {
    console.error('FAIL: one or more endpoints regressed.');
    process.exit(1);
  }
}

// Only run as CLI when invoked directly
const isEntryPoint =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('compare.ts') || process.argv[1].endsWith('compare.js'));

if (isEntryPoint) main();
