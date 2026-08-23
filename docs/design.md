# Vibecarbon Design Guide

Business vision and brand design guidelines.

---

## Brand Identity & Positioning

- **Project Name:** Vibecarbon
- **Primary Tagline:** "Professional Grade Vibecoding"
- **Subhead:** "Full-stack, Security hardened, Auto-everything Apps in less than 5 minutes."
- **Vision:** Sovereign, agnostic, grounded, agentic software architectures and tooling for developers and vibecoders — own it, move freely, stand on something real, build with agents.
- **Mission:** Eliminate the tradeoff between easy-to-start managed platforms and the control/cost-savings of self-hosting. Vibecarbon allows developers to own their infrastructure without needing a DevOps team or deep technical expertise.
- **Values**
    - Self-contained, Cloud agnostic, Portable
    - Fully automated: CICD, Scaling, Failover, Backups
    - Opinionated, but modular core stack
- **Pricing Strategy:** Fair Source CLI (FSL-1.1-MIT — each release converts to the MIT license two years after publication) with one-time license tiers: Graphite (free — local dev + single-server production deploys), Fullerene ($149, advanced deploy modes for your own products), Agency (contact us — deploy for clients and enterprise: white-label/resale work). Generated project code is MIT — users own their apps.

---

## Visual Design Language: "High-Performance Industrial" inspired by F1

*Design inspiration: F1 car aesthetics - precision engineering, carbon fiber textures, and aerodynamic forms.*

### Style

- Theme: Precision, strikingly refined, performance
- Colors: Gloss Black, Crisp White Reflections, Teal Accents
- Aesthetic: Dark, Moody, Minimal, Spacious, Through Lens with Depth of Field and elements at varied depths.

### UI Framework

[https://ui.shadcn.com/create?font=noto-sans&theme=teal&baseColor=gray&menuAccent=bold&base=base&style=maia](https://ui.shadcn.com/create?font=noto-sans&theme=teal&baseColor=gray&menuAccent=bold&base=base&style=maia)

### Typography

- **Body, UI, and headlines:** *Noto Sans Variable*. Headings use refined weights, tightened letter-spacing, and balanced wrapping rather than a separate display face (`--font-display` resolves to the body face; the Bricolage Grotesque display font was dropped 2026-07-01). Inter-class fonts at default weights are an explicit anti-"vibecoded" tell — do not reintroduce them.
- **Technical/Data:** *JetBrains Mono*, tabular "ledger numerals". Used for code blocks, KPI/data values, statistics, and technical labeling.

---

## Core UX & Interaction Mechanics

- **The Narrative (Scrollytelling):** The user moves *through* the content, not just down a page.
    - *Transformation:* The Hero section visually demonstrates the value proposition by morphing a **CLI Terminal** (The Work) into a **Live Dashboard** (The Reward) in a repeating animation.
- **Depth of Field (DoF):** The UI behaves like a camera lens. The active section is in crisp focus, while previous/next sections are heavily blurred (Bokeh effect) in the background.
- **Physics:** Elements have weight and magnetism. Elements move closer to the camera when as they get closer to the vertical center of the viewport and then retreat back as they approach moving out of frame. Buttons pull slightly toward the cursor; cards have "proximity glows" where borders light up when the mouse is near.
- **Texture:**
    - **Film Grain:** A subtle noise overlay to add tactile realism (anodized metal feel).
    - **Fresnel Edges:** Glass objects have glowing 1px edges that catch the light, differentiating them from matte plastic.
    - **Floor Reflections:** 3D objects are anchored by mirroring them on a reflective "shop floor" to create weight.

---

## Marketing Example: New Project to Prod in 3 Commands

```bash
# Create a new project
npx create-vibecarbon@latest [app-name]

# Run locally
npm run dev:start

# Deploy to production
vibecarbon deploy
```
