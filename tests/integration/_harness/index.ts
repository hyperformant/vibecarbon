/**
 * Single-import surface for the CLI test harness.
 *
 * Tests should import from here:
 *
 *     import {
 *       realProject,
 *       destroyRealProject,
 *       runCli,
 *       installExecStubs,
 *       assertSuccess,
 *       assertFileWritten,
 *     } from '../../_harness/index.js';
 */

export * from './assertions.js';
export * from './exec-stubs.js';
export * from './real-project.js';
export * from './run-cli.js';
