# Contributing to Vibecarbon

Thanks for your interest in improving Vibecarbon. This document covers how to
get set up, the checks your change must pass, and how contributions are
licensed.

## Getting started

- **Requirements:** Node ≥ 24.15, pnpm (`corepack enable`), Docker, and, for
  cloud deploys, the [Pulumi CLI](https://www.pulumi.com/docs/install/). Linux,
  macOS, or Windows via WSL2.
- Install: `pnpm install` (this also wires the repo's git hooks).
- The repo has two pnpm projects: the CLI at the root (`src/`) and the shipped
  application template in `carbon/`. They are versioned together but have
  separate dependencies, so align tooling by hand.

## Before you open a pull request

Run the pre-push gate locally:

```bash
pnpm test:prepush   # lint + unit + integration
```

- **Tests are required.** New behavior needs a test; a bug fix needs a
  regression test. Where a fix closes a class of problem, add a census/guard
  test that asserts the property across every member, not just the one you hit.
- **Lint must pass:** `pnpm lint` (shell-safety, stale-deploy, paid-boundary,
  Biome, and type-checks).
- Follow the existing style: single-dash CLI flags, interactive-by-default
  commands, no secrets in the tree.
- Real-infrastructure e2e tests (`pnpm test:e2e`) cost money and require cloud
  credentials; you are not expected to run them for most changes.

## Reporting bugs and security issues

- Bugs: open an issue using the bug-report template.
- Security vulnerabilities: **do not** open a public issue. See
  [SECURITY.md](./SECURITY.md).

## Licensing of contributions

Vibecarbon is distributed under the **Functional Source License, Version 1.1,
MIT Future License (`FSL-1.1-MIT`)**. By submitting a contribution you agree
that it is licensed under the same terms, including the MIT future-license
grant. That is, your contribution may be relicensed under MIT on the schedule
the FSL defines, alongside the rest of the project. Do not submit code you are
not authorized to license this way.
