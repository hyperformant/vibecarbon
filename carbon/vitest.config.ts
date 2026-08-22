import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Three-tier vitest setup mirroring vibecarbon's own layout (slimmed for an
// app — no real-infra e2e tier).
//
//   unit         pure functions, validators, shared lib       — node env, fast
//   component    React components + hooks via RTL             — jsdom env
//   integration  Hono route handlers w/ mocked externals      — node env
//
// `npm test` runs the full set; `npm run test:unit` etc. pick one tier.
//
// The `test-maintainer` subagent reads tests/ to learn this project's
// conventions — keep new tests in the matching tier directory so the agent
// can extend the pattern.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/client'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@server': resolve(import.meta.dirname, 'src/server'),
    },
  },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts', 'tests/**', 'node_modules'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // Pure, in-process. No DOM, no React. Validators, formatters,
          // pricing math, shared types.
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/structural/**/*.test.ts'],
          testTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'component',
          // React components + custom hooks via React Testing Library.
          // jsdom for DOM APIs; setup file wires @testing-library/jest-dom
          // matchers + auto-cleanup between tests.
          environment: 'jsdom',
          include: ['tests/component/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/_helpers/setup-rtl.ts'],
          testTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          // Hono route handlers exercised end-to-end via app.request(),
          // with external services (Supabase, Stripe, SMTP) mocked at the
          // module boundary. Tests the full request/response cycle —
          // schema validation, status codes, error mapping, rate-limit
          // wiring — without standing up real infra.
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/_helpers/setup-integration.ts'],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
