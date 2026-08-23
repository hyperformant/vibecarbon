# Billing modes: one-time purchases alongside subscriptions

## The problem

The template assumes subscriptions everywhere except the catalog. A generated
project selling a one-time product has a working checkout and nothing behind it:

`src/server/routes/webhooks/stripe.ts`

```js
if (session.mode !== 'subscription') {
  logger.debug('Ignoring non-subscription checkout session');
  return;
}
```

A customer pays, the provider fires `checkout.session.completed` with
`mode: 'payment'`, and the handler logs a debug line and returns. No record, no
email, no fulfilment. Nothing tells the operator it happened.

Three symptoms, one cause:

| Surface | One-time support |
| :--- | :--- |
| Catalog types (`billing-catalog.types.ts`) | models `month \| year \| one_time` — the only place that does |
| `createCheckout` | accepts `mode?: 'subscription' \| 'payment'` |
| CLI catalog sync | already split: provider read → provider-agnostic write |
| Webhook route | drops `mode: 'payment'` |
| Schema | `customers`, `subscriptions` — no purchase record |
| Emails | `subscriptionConfirmEmail`, `paymentFailedEmail` only |
| Onboarding | imports the demo `plans` and never reads the catalog |

The seams mostly exist. What is missing is the path between them.

## Decisions

**The catalog is the single source of truth for every billing surface.**
Marketing pricing, in-app pricing, and checkout all render from it. A
hand-maintained second tier list is exactly the drift that produced this
(vibecarbon.com's `PricingSection` disagreeing with an empty catalog).

**Onboarding does not sell.** The Plan step is removed outright rather than
made catalog-aware. Onboarding becomes Profile → Organization; monetization
lives on `/pricing` and in billing settings, where a customer can compare
features before committing. This deletes a whole class of drift by deleting a
surface, and makes one-time and subscription projects onboard identically.

**The template owns the mechanism; the project owns the payload.** The template
verifies, deduplicates, records, and emails. What the customer actually
*receives* — a license key, a download, a seat grant — is one project-owned
function. The template never learns what a license is.

**One-time handling is provider-agnostic.** It moves out of the Stripe route so
Paddle and Polar inherit it instead of each growing their own branch.

## Design

### Purchase record

A `purchases` table: provider, provider event id (unique — every provider
retries), customer, price id, amount, currency, `created_at`, `fulfilled_at`.
The unique event id is the idempotency key; a replayed webhook is a no-op.

### Fulfilment extension point

The template ships a no-op default. Projects replace the body, never the
signature:

```ts
export async function fulfillPurchase(purchase: Purchase): Promise<FulfillmentResult>;

interface FulfillmentResult {
  items: Array<{ label: string; value: string; copyable?: boolean; mono?: boolean }>;
}
```

Fulfilment returns **display items, not an email**. The template's
`purchaseConfirmEmail` renders them as copy-paste boxes. Email design stays in
one place and improves for everyone; a project supplies strings and knows
nothing about HTML. A project with nothing to hand over returns no items and
its customer gets a clean receipt.

### Durability

Providers retry on non-2xx, but a purchase that is recorded, ACKed, and then
fails to send is lost while looking complete. `fulfilled_at` stays null until
the email is out, and the existing pg_cron worker retries unfulfilled rows —
a column and a small job, not new infrastructure. Without it a transient SMTP
failure means a paying customer receives nothing and nothing reports it.

### Onboarding

Delete the Plan step and its `PlanId` coupling. `plans` in `@shared/pricing`
survives only as the empty-catalog fallback for `/pricing`, so it folds into
the catalog fallback rather than remaining a second pricing vocabulary.

## vibecarbon.com: the first consumer

vibecarbon.com implements `fulfillPurchase` by minting a license server-side.
It is the reference implementation, not a special case — which is the only
honest test of whether this seam is any good.

Key format is fixed by the shipped CLI, whose validator embeds the public half:

```
customerId = sha256(email.toLowerCase().trim()).slice(0, 8)
message    = "<tierChar>-<customerId>"          // fullerene -> "f"
key        = "vc-<tierChar>-<customerId>-<ed25519 sig hex>"
```

The key is **deterministic from (tier, email)**: re-minting a purchase yields
the identical key, so fulfilment retries are naturally idempotent and no key
storage is required to reissue.

```ts
return {
  items: [
    { label: 'Your license key', value: key, copyable: true },
    { label: 'Activate it', value: `vibecarbon activate ${key}`, copyable: true, mono: true },
  ],
};
```

**Blast radius to accept deliberately:** server-side minting puts
`VIBECARBON_LICENSE_PRIVATE_KEY` on the vibecarbon.com host. That key is what
makes every license trustworthy; until now it lived only on a laptop.

## Sequencing

vibecarbon.com ships first and independently — launch does not wait on the
template generalisation. A **native license model in the template** is a
post-launch fast follow; it replaces the *body* of `fulfillPurchase`, not the
interface, so vibecarbon.com's implementation does not get unwound.

## Out of scope

Catalog sync for Paddle and Polar. The provider-agnostic write seam
(`write-catalog.js`) already exists; only Stripe has a reader today, and adding
others is independent of this work.
