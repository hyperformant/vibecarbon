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
(a marketing pricing section disagreeing with an empty catalog).

**Onboarding does not sell.** The Plan step is removed outright rather than
made catalog-aware. Onboarding becomes Profile → Organization; monetization
lives on `/pricing` and in billing settings, where a customer can compare
features before committing. This deletes a whole class of drift by deleting a
surface, and makes one-time and subscription projects onboard identically.

**The template owns the mechanism; the project owns the payload.** The template
verifies, deduplicates, records, and emails. What the customer actually
*receives* (a download, a seat grant, an access code) is one project-owned
function. The template never learns what the product is.

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

## Out of scope

Catalog sync for Paddle and Polar. The provider-agnostic write seam
(`write-catalog.js`) already exists; only Stripe has a reader today, and adding
others is independent of this work.

## Implementation notes

Findings from the first implementation that any generalisation must carry:

- **Thread the event id, not the session id, into the purchase record.** The
  event is what providers redeliver; `checkout.session.completed` retried with
  the same `event.id` hits the UNIQUE constraint (Postgres 23505) and is a
  no-op. Webhook tests must pin this.
- **Record before delivering, and never fail the webhook on delivery.** Once
  ACKed, the provider never redelivers. A delivery failure stores
  `fulfillment_error`, leaves `fulfilled_at` null, and still returns 200 —
  failing the webhook would replay the whole event when only the email needs
  retrying. A paid session with NO email is the one case that must fail the
  webhook (nothing to fulfil to; let the provider retry).
- **Migrations must be DROP-first idempotent.** The deploy re-applies the whole
  migrations directory and `CREATE POLICY` has no `IF NOT EXISTS`; omitting the
  `DROP POLICY IF EXISTS` convention aborted a production deploy. Prove
  idempotency by applying the migration twice in one transaction.
- **Verify the deployed surface, not the deploy exit code.** The first "live"
  claim was disproven by one curl: a known API route returned JSON while the
  new route returned the SPA shell — the running build predated the change.
