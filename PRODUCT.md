# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is an AI-assisted builder: someone building a real product with coding agents who understands the principles of what they are making but has no DevOps team and does not want to become one. They are starting from an idea, not from an existing app, and they want it running on a server they rent and control.

The README names three situations this user is in:

- **Indie hackers and solopreneurs** launching a production-grade first version quickly while keeping the whole stack.
- **Startup founders and small teams** who need organisations, scaling and high availability without hiring a DevOps engineer.
- **Agencies and consultancies** who want one foundation for every client project and an easy handoff.

Experienced developers leaving managed platforms for cost and control are welcome and secondary.

## Product Purpose

Vibecarbon is a full-stack SaaS starter and the CLI that deploys and operates it. `vibecarbon create` generates an application the user owns (React 19, Vite, Tailwind v4, Hono, Better Auth, Postgres). The same CLI then deploys it to the user's own cloud account and runs it: backups, restore, scaling, replication and failover.

It exists to remove the tradeoff between managed platforms that are easy to start on and self-hosting that gives control and lower cost. Success is a builder going from an idea to a production app on infrastructure they own, and keeping it running, without needing DevOps expertise.

## Positioning

Self-hosting tools such as Coolify and Dokploy deploy an app the user has already built. Vibecarbon starts one step earlier: the user brings an idea and gets the application codebase itself (auth, billing, teams, admin) together with the tool that deploys and operates it.

The four commitments the project makes, in its own words:

- **Sovereign:** infrastructure, code, data and integrations under the user's control; the user picks the region.
- **Agnostic:** modular and portable; components can be swapped and the hosting provider changed without a rewrite.
- **Grounded:** open source under MIT, CLI and template alike.
- **Agentic:** built to be worked on with coding agents, with rules and guardrails for them in the generated project.

## Operating Context

- The user works in a terminal and an editor with a coding agent (Claude Code, Cursor, Windsurf or Copilot). The path from nothing to production is three commands: `npx vibecarbon@latest create`, `npm run dev:start`, `vibecarbon deploy`.
- The user supplies their own account with one of five providers: Hetzner, DigitalOcean, Linode, Vultr or Scaleway. They pay that provider's bill themselves.
- There are four deploy modes: a single Docker Compose server, Compose with a standby, Kubernetes, and Kubernetes with a standby region.
- This repository has two interfaces:
  - **The CLI**, which is the product's working surface.
  - **The template in `carbon/`**: the landing page, auth screens, dashboard, settings, admin panel, docs, blog and changelog that ship into every generated project. It is both Vibecarbon's showcase and the customer's starting point, and the customer rebrands it.
- Vibecarbon's own marketing site is a separate repository (`vibecarbon-web`) and is not covered by this record.

## Capabilities and Constraints

**In the generated application:** auth (email, OAuth, magic links, MFA), billing through Stripe, Paddle or Polar, multi-tenant organisations with roles, an admin panel, MDX blog, changelog, docs and legal pages, internationalisation, background jobs, file uploads, transactional email, newsletter, contact form, docs search, analytics and SEO.

**In the infrastructure:** automated deploys through CI/CD, auto-scaling, multi-region high availability with one-command failover, continuous backups with point-in-time restore, security hardening from the first deploy, and an optional observability add-on.

**Constraints future work must respect:**

- Everything under `carbon/` ships to customers as their own code. It must stay readable and self-contained, and it cannot depend on this repository.
- A generated project starts with the Vibecarbon icon as a placeholder that the customer replaces. The MIT licence covers the code, not the Vibecarbon name or logo (`TRADEMARK.md`).
- The template supports multiple languages; user-facing strings go through its translation files.

## Brand Commitments

- **Name:** Vibecarbon. **Tagline:** "Professional Grade Vibecoding". The README leads with "Build the next big thing."
- **Voice:**
  - Speak to a principled builder: lead with what they can now do, and use the technical modes as proof, not as the pitch.
  - "Free" describes the licence only. Never put it next to servers or deploys: the user pays their own cloud bill.
  - No em dashes in copy.
- **Assets:** the banner, architecture diagram, social preview and four pillar marks in `docs/assets/`.
- **Visual identity:** recorded separately in `docs/design.md`.

## Evidence on Hand

Real, and usable as proof:

- **Measured deploy times** from real end-to-end runs on real servers: the Performance section of `README.md`, with the data in `docs/perf-data.json`.
- **Supply-chain signals:** npm provenance attestation and the OpenSSF Scorecard, both shown as badges in the README.
- **The MIT licence** for the CLI, the template and generated code.
- **The running cost table** in the README ("What it costs to run"), built from provider prices.

Absent, and never to be invented: customer names or logos, testimonials, case studies, usage or download figures, press coverage, and benchmarks against other products.

## Product Principles

1. **The user owns it.** Code, data, servers and state belong to the user. Nothing in the product should create a dependency on Vibecarbon that they cannot leave.
2. **Start from an idea, arrive in production.** The product is judged on the whole path, from the first command to an app that stays up, not on any single step.
3. **Automation replaces expertise, and stays visible.** The hard operational work is done for the user, on machines they can log into, with no hidden control plane.
4. **Claims are measured.** A number or capability is stated only when it has been run on real infrastructure or is enforced by the code.
5. **One opinionated core, changeable parts.** Sensible defaults for everything, with components and providers the user can swap.
