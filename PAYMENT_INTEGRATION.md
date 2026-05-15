# Medusa Payment Integration — Deep Architectural Analysis

## Context

This document is a thorough analysis of the Medusa open-source commerce platform's payment integration system. Medusa is a TypeScript monorepo with 30+ modular commerce packages. The goal is to understand the payment architecture end-to-end: what processors exist, how they're structured, what workflows power them, and how they connect from cart checkout through order fulfillment.

---

## 1. Project Overview

**Medusa** is a headless commerce platform built as a TypeScript monorepo managed with Yarn workspaces. Its payment system is fully modular — providers are pluggable, flows are composable workflows, and API routes are thin controllers that delegate to reusable business logic.

```
/packages/
├── core/
│   ├── core-flows/          ← All payment workflows and steps
│   ├── framework/           ← Core runtime, DI container, HTTP
│   └── types/               ← All DTO/interface definitions
├── modules/
│   ├── payment/             ← Core payment module (service, models, loaders)
│   └── providers/
│       └── payment-stripe/  ← Stripe provider implementation
└── medusa/
    └── src/api/             ← HTTP route handlers (admin + store)
```

---

## 2. All Payment Providers & Processors

### 2.1 Built-in Providers (inside payment module)

| Provider | Identifier | File | Description |
|---|---|---|---|
| System | `system` | `packages/modules/payment/src/providers/system.ts` | Manual/cash payments — no-op provider for marking orders paid |
| Medusa Payments | `medusa-payments` | `packages/modules/payment/src/providers/payment-medusa/services/medusa-payments.ts` | Cloud-based Medusa payment processing (uses Stripe SDK types internally) |

### 2.2 Stripe Payment Providers (external package)

All located in `packages/modules/providers/payment-stripe/src/services/`

All extend **`StripeBase`** at `packages/modules/providers/payment-stripe/src/core/stripe-base.ts`

| Provider | Identifier | File | Payment Method | Region |
|---|---|---|---|---|
| Stripe (Card) | `stripe` | `stripe-provider.ts` | Credit/debit cards | Global |
| Stripe OXXO | `stripe-oxxo` | `stripe-oxxo.ts` | OXXO cash vouchers | Mexico |
| Stripe Bancontact | `stripe-bancontact` | `stripe-bancontact.ts` | Bancontact | Belgium |
| Stripe BLIK | `stripe-blik` | `stripe-blik.ts` | BLIK | Poland |
| Stripe Giropay | `stripe-giropay` | `stripe-giropay.ts` | Giropay | Germany |
| Stripe iDEAL | `stripe-ideal` | `stripe-ideal.ts` | iDEAL | Netherlands |
| Stripe Przelewy24 | `stripe-przelewy24` | `stripe-przelewy24.ts` | P24 | Poland |
| Stripe PromptPay | `stripe-promptpay` | `stripe-promptpay.ts` | PromptPay | Thailand |

**Total: 10 payment providers** (2 built-in + 8 Stripe variants)

### 2.3 Provider Registration

File: `packages/modules/payment/src/loaders/providers.ts`

- Container key format: `pp_{provider_identifier}` (e.g., `pp_stripe`, `pp_system`)
- System provider always registered first as `pp_system_default`
- Medusa payments registered conditionally based on cloud config
- External providers loaded via `moduleProviderLoader()`
- All providers upserted in DB via `PaymentProviderService.upsert()`

---

## 3. Payment Module Data Architecture

### 3.1 Entity Hierarchy

```
PaymentCollection (pay_col_*)
  ├── currency_code, amount, status
  ├── authorized_amount, captured_amount, refunded_amount
  ├── payment_providers (many-to-many)
  ├── PaymentSession[] (payses_*)
  │     ├── provider_id, data (provider-specific JSON), context
  │     ├── status: pending → authorized/captured/requires_more
  │     └── Payment (pay_*) ← created on authorize
  │           ├── captured_at, canceled_at
  │           ├── Capture[] (capt_*)  ← each capture event
  │           └── Refund[] (ref_*)    ← each refund event
  └── [linked to Cart or Order via remote join tables]
```

### 3.2 PaymentCollection Status Transitions

```
not_paid → awaiting → authorized → partially_captured → completed
                   ↘                               ↗
                    partially_authorized → captured
                   ↘
                    canceled / failed
```

Status is auto-updated by `maybeUpdatePaymentCollection_()` in `payment-module.ts` whenever payments are authorized or captured.

### 3.3 Models Location

All in `packages/modules/payment/src/models/`:
- `payment-collection.ts` — top-level container
- `payment-session.ts` — per-provider session state
- `payment.ts` — authorized/captured payment
- `capture.ts` — individual capture transaction
- `refund.ts` — individual refund transaction
- `refund-reason.ts` — refund reason codes
- `account-holder.ts` — customer payment account data
- `payment-provider.ts` — registered provider records

---

## 4. Core Payment Flows (Workflows)

### 4.1 Flow Architecture Pattern

All flows use the **Medusa Workflows SDK** (`packages/core/workflows-sdk/`):
- `createStep(id, action, compensation)` — atomic unit with rollback
- `createWorkflow(id, function)` — composable, chainable, hook-able
- `when()` — conditional branching
- `parallelize()` — concurrent steps
- `transform()` — pure data transformations
- `createHook()` — extension points for custom logic
- `runAsStep()` — embed sub-workflows as steps

---

### 4.2 Cart Checkout Payment Flows

#### Flow A: Create Payment Collection for Cart
**File:** `packages/core/core-flows/src/cart/workflows/create-payment-collection-for-cart.ts`
**ID:** `create-payment-collection-for-cart`

```
POST /store/payment-collections { cart_id }
  ↓
acquireLockStep (cart_id, 2s timeout, 10s TTL)
  ↓
useRemoteQueryStep (fetch cart)
  ↓
parallelize:
  ├── validateCartStep
  └── validateExistingPaymentCollectionStep
  ↓
createPaymentCollectionsStep → PaymentCollection in DB
  ↓
createRemoteLinkStep (cart ←→ payment_collection)
  ↓
releaseLockStep
```

#### Flow B: Create Payment Session (Provider Init)
**File:** `packages/core/core-flows/src/payment/workflows/create-payment-sessions.ts`
**Used by:** `POST /store/payment-collections/[id]/payment-sessions`

```
createPaymentSessionsWorkflow({ payment_collection_id, provider_id, customer_id, data, context })
  ↓
useRemoteQueryStep (fetch collection: amount, currency_code)
  ↓
[if customer_id] fetch/create account holder
  ↓
deletePaymentSessionsWorkflow (remove stale sessions — no split payments)
  ↓
createPaymentSessionStep:
  └── paymentModuleService.createPaymentSession()
        ├── Create PaymentSession entity in DB (status: pending)
        ├── Call provider.initiatePayment(context, amount, currency)
        └── Merge provider response into session.data
  ↓
Return PaymentSessionDTO (with provider data merged in, e.g. Stripe client_secret)
```

#### Flow C: Refresh Payment Collection (Cart Updates)
**File:** `packages/core/core-flows/src/cart/workflows/refresh-payment-collection.ts`
**ID:** `refresh-payment-collection-for-cart`

Triggered when cart amount or currency changes:
- Deletes existing payment sessions
- Updates payment collection amount/currency
- Has `validate` hook for custom validation

---

### 4.3 Authorization Flow

**File:** `packages/core/core-flows/src/payment/steps/authorize-payment-session.ts`
**ID:** `authorize-payment-session-step`

```
authorizePaymentSession(sessionId, context)
  ↓
Retrieve session with full relations
  ↓
Check idempotency (already authorized? return early)
  ↓
provider.authorizePayment({ data, context })
  └── Returns { data, status: AUTHORIZED | CAPTURED | REQUIRES_MORE }
  ↓
authorizePaymentSession_():
  ├── Create Payment entity in DB
  ├── Update PaymentSession status + authorized_at
  └── [If status = CAPTURED] auto-capture full amount
  ↓
Compensation on failure:
  └── paymentModule.cancelPayment() [unless REQUIRES_MORE]
```

**Error types:**
- `PAYMENT_REQUIRES_MORE_ERROR` — provider needs additional action (3DS, etc.)
- `PAYMENT_AUTHORIZATION_ERROR` — authorization failed

---

### 4.4 Cart Completion Flow

```
completeCartWorkflow:
  ↓
validateCartPaymentsStep:
  ├── Checks valid statuses: PENDING, REQUIRES_MORE, AUTHORIZED, CAPTURED
  ├── Allows skip if credit lines cover total
  └── Throws if no valid payment session
  ↓
authorizePaymentSessionStep (if not yet authorized)
  ↓
[create Order from Cart]
  ↓
compensatePaymentIfNeeded (compensation step):
  └── If cart completion fails after payment capture:
      └── refundPaymentAndRecreatePaymentSessionWorkflow
```

---

### 4.5 Capture Payment Flow

**File:** `packages/core/core-flows/src/payment/workflows/capture-payment.ts`
**ID:** `capture-payment-workflow`
**API:** `POST /admin/payments/[id]/capture`

```
capturePaymentWorkflow({ payment_id, amount?, captured_by })
  ↓
capturePaymentStep:
  ├── Retrieve payment with captures
  ├── Validate: newCapture + alreadyCaptured ≤ authorizedAmount
  ├── Create Capture entity in DB
  ├── Call provider.capturePayment()
  ├── Update payment.captured_at if fully captured
  └── Update PaymentCollection amounts
  ↓
useRemoteQueryStep (check if order exists for payment_collection)
  ↓
[if order exists]
  └── addOrderTransactionStep (record in order ledger)
  ↓
emitEventStep (PAYMENT_CAPTURED event)
```

Supports **partial capture**: call multiple times with `amount` to capture incrementally.

---

### 4.6 Refund Flows

#### Single Refund
**File:** `packages/core/core-flows/src/payment/workflows/refund-payment.ts`
**ID:** `refund-payment-workflow`
**API:** `POST /admin/payments/[id]/refund`

```
refundPaymentWorkflow({ payment_id, amount?, refund_reason_id, note, created_by })
  ↓
validateRefundPaymentExceedsCapturedAmountStep
  ↓
refundPaymentStep → provider.refundPayment()
  ↓
[if order exists] addOrderTransactionStep
  ↓
[if credit line needed] createOrderRefundCreditLinesWorkflow
  ↓
emitEventStep (PAYMENT_REFUNDED event)
```

#### Batch Refund
**File:** `packages/core/core-flows/src/payment/workflows/refund-payments.ts`
**ID:** `refund-payments-workflow`

- Validates ALL payments before processing any
- Processes in parallel via `Promise.all()`
- Continues on individual errors (logs, doesn't halt batch)

#### Full Order Refund
**File:** `packages/core/core-flows/src/order/workflows/payments/refund-captured-payments.ts`
**ID:** `refund-captured-payments-workflow`

Auto-calculates amounts: `captured - already_refunded` for each payment, then calls `refundPaymentsWorkflow`.

---

### 4.7 Webhook Processing Flow

**File:** `packages/core/core-flows/src/payment/workflows/process-payment.ts`
**ID:** `process-payment-workflow`

```
processPaymentWorkflow(WebhookActionResult { action, data: { session_id, amount } })
  ↓
useQueryGraphStep (get payment from session)
  ↓
useQueryGraphStep (get cart payment collection)
  ↓
[if cart exists] acquireLockStep (30s timeout, 2min TTL)
  ↓
Switch on action:
  ├── SUCCESSFUL + payment exists:
  │     └── capturePaymentWorkflow.runAsStep()
  ├── SUCCESSFUL + no payment (autocapture):
  │     ├── authorizePaymentSessionStep
  │     └── capturePaymentWorkflow.runAsStep()
  └── AUTHORIZED + no cart:
        └── authorizePaymentSessionStep
  ↓
releaseLockStep
  ↓
[if cart exists but no order]
  └── completeCartAfterPaymentStep → completeCartWorkflow
```

---

### 4.8 Order Payment Collection Flows

| Workflow | ID | File | Purpose |
|---|---|---|---|
| Create | `create-order-payment-collection` | `order/workflows/create-order-payment-collection.ts` | Creates PaymentCollection for existing order |
| Delete | `delete-order-payment-collection` | `order/workflows/delete-order-payment-collection.ts` | Deletes if status is `not_paid` only |
| Mark as Paid | `mark-payment-collection-as-paid` | `order/workflows/mark-payment-collection-as-paid.ts` | Uses System provider to mark manual payment |
| Create or Update | `create-or-update-order-payment-collection` | `order/workflows/create-or-update-order-payment-collection.ts` | Smart upsert with authorized payment cancellation |
| Refund Credit Lines | `create-order-refund-credit-lines` | `order/workflows/payments/create-order-refund-credit-lines.ts` | Creates credit line order change for over-refunds |

---

## 5. API Routes

### 5.1 Admin Routes

| Method | Path | File | Workflow Used |
|---|---|---|---|
| GET | `/admin/payments` | `admin/payments/route.ts` | Remote query |
| POST | `/admin/payments/[id]/capture` | `admin/payments/[id]/capture/route.ts` | `capturePaymentWorkflow` |
| POST | `/admin/payments/[id]/refund` | `admin/payments/[id]/refund/route.ts` | `refundPaymentWorkflow` |
| GET | `/admin/payments/payment-providers` | `admin/payments/payment-providers/route.ts` | Remote query |
| POST | `/admin/payment-collections` | `admin/payment-collections/route.ts` | `createOrderPaymentCollectionWorkflow` |
| DELETE | `/admin/payment-collections/[id]` | `admin/payment-collections/[id]/route.ts` | `deleteOrderPaymentCollections` |
| POST | `/admin/payment-collections/[id]/payment-sessions` | `admin/payment-collections/[id]/payment-sessions/route.ts` | `createPaymentSessionsWorkflow` |
| POST | `/admin/payment-collections/[id]/mark-as-paid` | `admin/payment-collections/[id]/mark-as-paid/route.ts` | `markPaymentCollectionAsPaidWorkflow` |

### 5.2 Store Routes

| Method | Path | File | Workflow Used |
|---|---|---|---|
| POST | `/store/payment-collections` | `store/payment-collections/route.ts` | `createPaymentCollectionForCartWorkflow` |
| POST | `/store/payment-collections/[id]/payment-sessions` | `store/payment-collections/[id]/payment-sessions/route.ts` | `createPaymentSessionsWorkflow` |

---

## 6. Provider Interface Contract

All providers implement `IPaymentProvider` from `packages/core/types/src/payment/provider.ts`:

```typescript
// Required methods
initiatePayment(input)     → { data, status }   // Create session/intent
updatePayment(input)       → { data, status }   // Update session
deletePayment(input)       → { data, status }   // Delete/void
authorizePayment(input)    → { data, status }   // Reserve funds
getPaymentStatus(input)    → { status }         // Check status
capturePayment(input)      → { data, status }   // Settle funds
cancelPayment(input)       → { data, status }   // Cancel/void
refundPayment(input)       → { data, status }   // Return funds
getWebhookActionAndData()  → WebhookActionResult

// Optional (account holders, saved payment methods)
createAccountHolder()
retrieveAccountHolder()
updateAccountHolder()
deleteAccountHolder()
listPaymentMethods()
savePaymentMethod()
```

**Context passed to all provider calls:**
```typescript
{
  account_holder?: { data: Record<string, unknown> }
  customer?: { id, email, first_name, last_name, billing_address, ... }
  idempotency_key?: string  // = payment session ID
}
```

---

## 7. Stripe Provider Deep Dive

### StripeBase (`stripe-base.ts`) Key Behaviors
- **`normalizePaymentIntentParameters()`** — maps Medusa context to Stripe PaymentIntent params
- **`handleStripeError()`** — standardized error handling
- **`executeWithRetry()`** — exponential backoff for transient failures
- **`constructWebhookEvent()`** — validates Stripe webhook signatures
- **`paymentIntentOptions`** — abstract property overridden per payment method type

### Stripe Variant Pattern (Strategy)
Each method variant only overrides `paymentIntentOptions`:
```typescript
// iDEAL example
get paymentIntentOptions() {
  return {
    payment_method_types: ["ideal"],
    capture_method: "automatic",
  }
}
```

### StripeOptions Configuration
```typescript
{
  apiKey: string              // Required
  webhookSecret: string       // Required
  capture?: boolean           // Auto-capture (default: false)
  automaticPaymentMethods?: boolean
  paymentDescription?: string
  oxxoExpiresDays?: number   // default: 3
}
```

---

## 8. End-to-End Payment Journey

### Customer Checkout Journey

```
1. Customer adds items to cart
   └── Cart created/updated

2. Customer initiates checkout
   POST /store/payment-collections { cart_id }
   └── createPaymentCollectionForCartWorkflow
       └── PaymentCollection created, linked to cart

3. Customer selects payment method (e.g., Stripe)
   POST /store/payment-collections/[id]/payment-sessions { provider_id: "stripe" }
   └── createPaymentSessionsWorkflow
       ├── Deletes existing sessions
       ├── Calls stripe.initiatePayment() → creates PaymentIntent
       └── Returns client_secret for frontend Stripe.js

4. Frontend completes payment (Stripe.js confirmPayment)
   └── Stripe calls webhook → POST /hooks/payment/stripe

5. Webhook processing
   └── processPaymentWorkflow
       ├── [if SUCCESSFUL + autocapture] authorizes + captures
       ├── [if AUTHORIZED] authorizes session only
       └── [if cart exists without order] completeCartWorkflow

6. Cart completion (may happen synchronously or via webhook)
   └── completeCartWorkflow
       ├── validateCartPaymentsStep (ensures valid payment session)
       ├── authorizePaymentSessionStep (if not yet done)
       └── Creates Order from Cart
```

### Admin Fulfillment Journey

```
7. Admin reviews order
   └── Order linked to PaymentCollection (status: authorized)

8. Admin captures payment
   POST /admin/payments/[id]/capture { amount? }
   └── capturePaymentWorkflow
       ├── provider.capturePayment() → settles funds with Stripe
       ├── Creates Capture entity
       ├── Adds order transaction
       └── Emits PAYMENT_CAPTURED event

9. Admin issues refund (if needed)
   POST /admin/payments/[id]/refund { amount, refund_reason_id, note }
   └── refundPaymentWorkflow
       ├── Validates amount ≤ captured
       ├── provider.refundPayment() → issues refund via Stripe
       ├── Creates Refund entity
       ├── Adds order transaction
       └── [if over-refund] createOrderRefundCreditLinesWorkflow
```

---

## 9. Architectural Assessment

### Strengths

1. **Hexagonal Architecture** — Payment module core is isolated from providers via `IPaymentProvider` interface. Providers are adapters, business logic lives in the module service.

2. **Saga Pattern for Compensation** — Every workflow step has compensation logic. If cart completion fails after payment capture, `compensatePaymentIfNeeded` triggers refund + session recreation automatically.

3. **Idempotency Built-in** — Authorization checks for existing Payment before creating another. Lock management prevents race conditions on concurrent cart updates.

4. **Strategy Pattern for Stripe Variants** — Adding a new regional payment method (e.g., Stripe WeChat Pay) requires only implementing `paymentIntentOptions` — zero code duplication.

5. **Event-Driven Integration** — `emitEventStep` after capture/refund decouples downstream concerns (notifications, analytics) from payment flows.

6. **Composable Workflows** — `runAsStep()` enables workflow reuse — `capturePaymentWorkflow` is called from both admin routes AND webhook processing flow.

7. **Mathematical Precision** — `MathBN` library used for all currency calculations preventing float precision bugs.

### Gaps / Areas to Watch

1. **No PayPal, Klarna, or Buy-Now-Pay-Later providers** out of the box — only Stripe and system provider. Third-party packages needed for others.

2. **Single payment session per collection** — `createPaymentSessionsWorkflow` deletes existing sessions before creating a new one — no native split-payment support.

3. **Webhook routing is provider-specific** — Each provider needs its own webhook endpoint registered (not consolidated).

4. **`MedusaPaymentsProvider`** (cloud) uses Stripe SDK types internally — tight coupling that may limit its extensibility.

---

## 10. Critical Files Reference

| Area | File |
|---|---|
| Provider interface | `packages/core/types/src/payment/provider.ts` |
| Payment module service | `packages/modules/payment/src/services/payment-module.ts` |
| Provider loader/registration | `packages/modules/payment/src/loaders/providers.ts` |
| Stripe base provider | `packages/modules/providers/payment-stripe/src/core/stripe-base.ts` |
| Capture workflow | `packages/core/core-flows/src/payment/workflows/capture-payment.ts` |
| Refund workflow | `packages/core/core-flows/src/payment/workflows/refund-payment.ts` |
| Batch refund workflow | `packages/core/core-flows/src/payment/workflows/refund-payments.ts` |
| Process payment (webhooks) | `packages/core/core-flows/src/payment/workflows/process-payment.ts` |
| Cart payment collection | `packages/core/core-flows/src/cart/workflows/create-payment-collection-for-cart.ts` |
| Refresh payment collection | `packages/core/core-flows/src/cart/workflows/refresh-payment-collection.ts` |
| Authorize session step | `packages/core/core-flows/src/payment/steps/authorize-payment-session.ts` |
| Cancel payment step | `packages/core/core-flows/src/payment/steps/cancel-payment.ts` |
| Admin capture route | `packages/medusa/src/api/admin/payments/[id]/capture/route.ts` |
| Admin refund route | `packages/medusa/src/api/admin/payments/[id]/refund/route.ts` |
| Store payment collection | `packages/medusa/src/api/store/payment-collections/route.ts` |
| Payment data models | `packages/modules/payment/src/models/` |
| Payment DTOs/types | `packages/core/types/src/payment/` |





  ---
  Phase 1 — Frontend collects card

  Customer types card number on the frontend. Stripe.js (a JavaScript library) handles this and creates a PaymentMethod on Stripe's servers. Medusa is not involved here at all.

  ---
  Phase 2 — Medusa creates a PaymentIntent

  When customer clicks "Place Order":

  Frontend → POST /store/carts/{id}/complete
                ↓
           Medusa calls stripe.paymentIntents.create()
                ↓
           Stripe returns:  { id: "pi_xxx", client_secret: "pi_xxx_secret_yyy", status: "requires_capture" }
                ↓
           Medusa maps status → AUTHORIZED
           Creates Order

  pi_xxx is stored in session.data.id — this is the key used for all future operations.

  ---
  Phase 3 — Admin captures money

  Admin clicks "Capture"
      ↓
  Medusa reads session.data.id = "pi_xxx"
      ↓
  stripe.paymentIntents.capture("pi_xxx")
      ↓
  Money moves from customer → merchant

  ---
  Refund works the same way

  Admin clicks "Refund"
      ↓
  Medusa reads session.data.id = "pi_xxx"
      ↓
  stripe.refunds.create({ payment_intent: "pi_xxx", amount: ... })

  ---
  One line summary: Medusa stores the Stripe PaymentIntent ID in session.data.id during checkout, then uses that same ID for every operation — capture, refund, cancel.




















  POST /store/payment-collections/{id}/payment-sessions
      ↓
  createPaymentSessionsWorkflow
      ↓
  createPaymentSessionStep
      ↓
  PaymentModule.createPaymentSession()
      ↓
  PaymentProviderService.createSession()
      ↓
  provider.initiatePayment()           ← stripe-base.ts:262
      ↓
  stripe.paymentIntents.create()

  So stripe.paymentIntents.create() is called the moment the frontend posts to /payment-sessions — not at cart completion. That's when the Stripe PaymentIntent is created and client_secret is returned to the frontend so Stripe.js can collect the
  card details.

  The corrected mental model:

  1. Frontend → POST /store/payment-collections/{id}/payment-sessions
               → Medusa calls stripe.paymentIntents.create()
               → Returns client_secret to frontend

  2. Frontend uses client_secret with Stripe.js to collect card details
     (Stripe handles card tokenization — Medusa not involved)

  3. Frontend → POST /store/carts/{id}/complete
               → Medusa calls stripe.paymentIntents.retrieve(pi_xxx)
               → Maps status → AUTHORIZED
               → Creates Order

  So the sequence is create intent first, collect card second — not the other way around.







    ---
  Step 1 — Get an admin auth token

  curl -X POST http://localhost:9000/auth/user/emailpass \
    -H "Content-Type: application/json" \
    -d '{"email": "admin@medusa-test.com", "password": "supersecret"}' \
    | jq '.token'

  Save the token as ADMIN_TOKEN.

  ---
  Step 2 — Link the Stripe provider to a region

  First get your region id:
  curl http://localhost:9000/admin/regions \
    -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.regions[].id'

  Then link the provider:
  curl -X POST http://localhost:9000/admin/regions/$REGION_ID \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"payment_providers": ["pp_hyperswitch-prism_hyperswitch-prism-stripe"]}'

  ---
  Step 3 — Create a cart (store side)

  curl -X POST http://localhost:9000/store/carts \
    -H "Content-Type: application/json" \
    -d '{"region_id": "$REGION_ID"}' | jq '.cart.id'

  Save as CART_ID.

  ---
  Step 4 — Create a payment collection

  curl -X POST http://localhost:9000/store/payment-collections \
    -H "Content-Type: application/json" \
    -d '{"cart_id": "$CART_ID"}' | jq '.payment_collection.id'

  Save as PAYMENT_COLLECTION_ID.

  ---
  Step 5 — Initialize payment session (calls initiatePayment)

  curl -X POST http://localhost:9000/store/payment-collections/$PAYMENT_COLLECTION_ID/payment-sessions \
    -H "Content-Type: application/json" \
    -d '{"provider_id": "pp_hyperswitch-prism_hyperswitch-prism-stripe"}'