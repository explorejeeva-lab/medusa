# Implementation Plan: Medusa Payment Provider for Hyperswitch-Prism

## Context

This plan integrates `hyperswitch-prism` (Juspay's unified payment connector library supporting 120+ processors) as a native Medusa payment provider. The `hyperswitch-prism` npm SDK is wrapped inside a new Medusa provider package at `packages/modules/providers/payment-hyperswitch-prism/`, giving Medusa access to every connector Prism supports through a single provider.

---

## Critical: How Prism Differs from Stripe

Before implementation, understand this fundamental difference:

| Aspect | Stripe provider (current) | Hyperswitch-Prism |
|---|---|---|
| `initiatePayment` | Creates a PaymentIntent → returns `client_secret` for frontend | **No equivalent** — Prism's `authorize()` requires raw card data NOW |
| Card collection | Frontend uses Stripe.js with `client_secret` | Card data must arrive server-side (server-to-server flow) |
| Payment session | Stripe holds the intent server-side | Prism is stateless — no session created on their side |
| `authorizePayment` | Polls existing PaymentIntent status | **Performs the actual Prism `authorize()` call** with card data |
| Status codes | Stripe intent status strings | **Numeric enums** — `AUTHORIZED = 6`, `CHARGED = 8` |
| Refund status | Same PaymentStatus enum | **Separate RefundStatus enum** — `REFUND_SUCCESS = 4` |

**Design decision:** Because Prism is server-to-server and stateless:
- `initiatePayment` → creates a local pending session (no Prism API call), stores connector metadata + card data
- `authorizePayment` → **performs the actual Prism `authorize()` call**, using card data from `input.data`
- Card data must be passed through the payment session `data` field from the storefront

---

## Target Directory

```
packages/modules/providers/payment-hyperswitch-prism/
```

Package name: `@medusajs/payment-hyperswitch-prism`
Provider identifier: `hyperswitch-prism`

---

## File Structure to Create

```
packages/modules/providers/payment-hyperswitch-prism/
├── src/
│   ├── index.ts                        ← ModuleProvider export
│   ├── services/
│   │   └── hyperswitch-prism.ts        ← Main provider class
│   ├── types/
│   │   └── index.ts                    ← HyperswitchPrismOptions + status constants
│   └── utils/
│       └── get-amount.ts               ← Minor unit ↔ decimal conversion
├── package.json
└── tsconfig.json
```

---

## 1. `package.json`

```json
{
  "name": "@medusajs/payment-hyperswitch-prism",
  "version": "2.15.2",
  "description": "Hyperswitch Prism payment provider for Medusa",
  "main": "dist/index.js",
  "files": ["dist", "!dist/**/__tests__", "!dist/**/__mocks__"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "../../../../node_modules/.bin/jest --passWithNoTests src",
    "build": "yarn run -T rimraf dist && yarn run -T tsc --build ./tsconfig.json",
    "watch": "yarn run -T tsc --watch"
  },
  "devDependencies": {
    "@medusajs/framework": "2.15.2"
  },
  "peerDependencies": {
    "@medusajs/framework": "2.15.2"
  },
  "dependencies": {
    "hyperswitch-prism": "latest"
  },
  "keywords": ["medusa-plugin", "medusa-plugin-payment"]
}
```

---

## 2. `tsconfig.json`

```json
{
  "extends": "../../../../_tsconfig.base.json",
  "compilerOptions": {
    "paths": {
      "@types": ["./src/types"],
      "@utils": ["./src/utils"]
    }
  }
}
```

---

## 3. `src/types/index.ts`

```typescript
export interface HyperswitchPrismOptions {
  connector: string                        // "stripe" | "adyen" | "paypal" | ...
  connectorConfig: Record<string, unknown> // connector credentials — format: { apiKey: { value: "..." } }
  webhookSecret?: string                   // for webhook signature verification
  environment?: "SANDBOX" | "PRODUCTION"  // default: SANDBOX
  capture?: boolean                        // auto-capture on authorize (default: false = MANUAL)
}

// Prism status codes are NUMBERS (not strings)
// PaymentStatus and RefundStatus are SEPARATE enums — do NOT mix them
export const PrismPaymentStatus = {
  UNSPECIFIED: 0,
  STARTED: 1,
  AUTHENTICATION_PENDING: 4,   // 3DS or redirect required
  AUTHENTICATION_SUCCESSFUL: 5,
  AUTHORIZED: 6,               // funds reserved, not yet captured
  AUTHORIZATION_FAILED: 7,
  CHARGED: 8,                  // fully captured
  VOIDED: 11,                  // cancelled/voided
  PENDING: 20,                 // async — wait for webhook
  FAILURE: 21,                 // soft decline
} as const

export const PrismRefundStatus = {
  REFUND_FAILURE: 1,
  REFUND_MANUAL_REVIEW: 2,
  REFUND_PENDING: 3,
  REFUND_SUCCESS: 4,           // NOTE: value 4 here ≠ AUTHENTICATION_PENDING (4) in PaymentStatus
} as const
```

---

## 4. `src/utils/get-amount.ts`

Prism uses `minorAmount` (integer cents). Medusa amounts are decimals.

```typescript
// Zero-decimal currencies use 0 decimal places, all others use 2
const ZERO_DECIMAL_CURRENCIES = new Set([
  "jpy", "krw", "vnd", "gnf", "mga", "pyg", "rwf", "ugx", "xaf", "xof",
])

export function toMinorAmount(amount: number, currencyCode: string): number {
  const decimals = ZERO_DECIMAL_CURRENCIES.has(currencyCode.toLowerCase()) ? 0 : 2
  return Math.round(amount * Math.pow(10, decimals))
}

export function fromMinorAmount(minorAmount: number, currencyCode: string): number {
  const decimals = ZERO_DECIMAL_CURRENCIES.has(currencyCode.toLowerCase()) ? 0 : 2
  return minorAmount / Math.pow(10, decimals)
}
```

---

## 5. `src/services/hyperswitch-prism.ts` — Full Provider Class

### Payment flow step-by-step

```
Storefront:
  POST /store/payment-collections/:id/payment-sessions
    { provider_id: "hyperswitch-prism_hyperswitch-prism", data: { paymentMethod: { card: {...} } } }
      ↓
  → initiatePayment()
      NO Prism API call. Stores card data + connector metadata in session.data.
      Returns: { status: PENDING, data: { merchantTransactionId, connectorName, paymentMethod, ... } }

  Checkout completes → authorizePayment() is called
      → Prism client.authorize() called with card data from session.data
      Returns: { status: AUTHORIZED | CAPTURED, data: { connectorTransactionId, ... } }

Admin:
  POST /admin/payments/:id/capture  → capturePayment()  → Prism client.capture()
  POST /admin/payments/:id/refund   → refundPayment()   → Prism client.refund()

Webhook (optional):
  POST /hooks/payment/hyperswitch-prism_hyperswitch-prism
      → getWebhookActionAndData()  → eventClient.handleEvent()
```

### Medusa method → Prism SDK method mapping

| Medusa Method | Prism SDK Call | Notes |
|---|---|---|
| `initiatePayment` | *(none)* | Stores metadata only — Prism is stateless |
| `authorizePayment` | `paymentClient.authorize()` | Uses card data from `session.data` |
| `capturePayment` | `paymentClient.capture()` | Uses `connectorTransactionId` from `data` |
| `refundPayment` | `paymentClient.refund()` | Uses `RefundStatus` enum, NOT `PaymentStatus` |
| `cancelPayment` | `paymentClient.void()` | No-op if not yet authorized |
| `deletePayment` | `paymentClient.void()` | Delegates to `cancelPayment` |
| `getPaymentStatus` | `paymentClient.sync()` | Returns `PENDING` if no `connectorTransactionId` yet |
| `retrievePayment` | `paymentClient.get()` | Fetches raw connector data |
| `updatePayment` | void → re-initiate | Prism has no update API |
| `getWebhookActionAndData` | `eventClient.handleEvent()` | Maps numeric status → `PaymentActions` |

### Full implementation

```typescript
import {
  AbstractPaymentProvider,
  PaymentActions,
  PaymentSessionStatus,
  isDefined,
} from "@medusajs/framework/utils"
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  PaymentClient,
  EventClient,
  types,
  IntegrationError,
  ConnectorError,
  NetworkError,
} from "hyperswitch-prism"
import { HyperswitchPrismOptions, PrismPaymentStatus, PrismRefundStatus } from "@types"
import { toMinorAmount } from "@utils/get-amount"

class HyperswitchPrismProviderService extends AbstractPaymentProvider<HyperswitchPrismOptions> {
  static identifier = "hyperswitch-prism"

  protected options_: HyperswitchPrismOptions
  protected paymentClient_: PaymentClient
  protected eventClient_: EventClient

  static validateOptions(options: HyperswitchPrismOptions): void {
    if (!isDefined(options.connector)) {
      throw new Error(
        "Required option `connector` is missing in Hyperswitch Prism provider"
      )
    }
    if (!isDefined(options.connectorConfig)) {
      throw new Error(
        "Required option `connectorConfig` is missing in Hyperswitch Prism provider"
      )
    }
  }

  constructor(cradle: Record<string, unknown>, options: HyperswitchPrismOptions) {
    // @ts-ignore
    super(...arguments)
    this.options_ = options

    // connectorConfig format: { stripe: { apiKey: { value: "sk_..." } } }
    const prismConfig = {
      connectorConfig: { [options.connector]: options.connectorConfig },
      options: {
        environment:
          options.environment === "PRODUCTION"
            ? types.Environment.PRODUCTION
            : types.Environment.SANDBOX,
      },
    }

    this.paymentClient_ = new PaymentClient(prismConfig)
    this.eventClient_ = new EventClient(prismConfig)
  }

  // ── Status mapping ────────────────────────────────────────────────────────
  // IMPORTANT: Prism status codes are NUMBERS, not strings

  private mapPrismPaymentStatus(status: number): PaymentSessionStatus {
    switch (status) {
      case PrismPaymentStatus.AUTHORIZED: // 6
        return PaymentSessionStatus.AUTHORIZED
      case PrismPaymentStatus.CHARGED: // 8
        return PaymentSessionStatus.CAPTURED
      case PrismPaymentStatus.AUTHENTICATION_PENDING: // 4 — redirect/3DS required
        return PaymentSessionStatus.REQUIRES_MORE
      case PrismPaymentStatus.PENDING: // 20 — async, wait for webhook
        return PaymentSessionStatus.PENDING
      case PrismPaymentStatus.VOIDED: // 11
        return PaymentSessionStatus.CANCELED
      case PrismPaymentStatus.AUTHORIZATION_FAILED: // 7
      case PrismPaymentStatus.FAILURE: // 21 — soft decline
        return PaymentSessionStatus.ERROR
      default:
        return PaymentSessionStatus.PENDING
    }
  }

  private buildError(message: string, error: unknown): Error {
    if (error instanceof IntegrationError) {
      return new Error(
        `[Hyperswitch Prism IntegrationError] ${message}: ${error.message} (code: ${error.errorCode})`
      )
    }
    if (error instanceof ConnectorError) {
      return new Error(
        `[Hyperswitch Prism ConnectorError] ${message}: ${error.message} (code: ${error.errorCode}, http: ${error.httpStatusCode})`
      )
    }
    if (error instanceof NetworkError) {
      return new Error(
        `[Hyperswitch Prism NetworkError] ${message}: ${error.message}`
      )
    }
    return new Error(`${message}: ${(error as Error).message}`)
  }

  // ── initiatePayment ───────────────────────────────────────────────────────
  // Prism is stateless — no server-side session to create.
  // Store connector metadata + card data in Medusa's session.data
  // so authorizePayment() can use it later.

  async initiatePayment({
    currency_code,
    amount,
    data,
    context,
  }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const merchantTransactionId =
      (context?.idempotency_key as string) ?? `hs_${Date.now()}`

    return {
      id: merchantTransactionId,
      data: {
        merchantTransactionId,
        connector: this.options_.connector,
        currency: currency_code,
        minorAmount: toMinorAmount(Number(amount), currency_code),
        // card data / paymentMethod from storefront flows through input.data
        paymentMethod: (data as any)?.paymentMethod ?? null,
        // extra connector-specific fields (e.g. browserInfo for Adyen) pass through
        extra: data ?? {},
      },
      status: PaymentSessionStatus.PENDING,
    }
  }

  // ── authorizePayment ──────────────────────────────────────────────────────
  // THIS is where the actual Prism API call happens.
  // Card data comes from session.data set in initiatePayment.

  async authorizePayment({
    data,
    context,
  }: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const { merchantTransactionId, currency, minorAmount, paymentMethod, extra } =
      data as any

    try {
      const res = await this.paymentClient_.authorize({
        merchantTransactionId,
        amount: {
          minorAmount: minorAmount as number,
          currency: (currency as string).toUpperCase() as types.Currency,
        },
        captureMethod: this.options_.capture
          ? types.CaptureMethod.AUTOMATIC
          : types.CaptureMethod.MANUAL,
        paymentMethod,
        // Pass any connector-specific fields (browserInfo for Adyen, etc.)
        ...(extra as Record<string, unknown>),
      })

      // connectorTransactionId may be undefined on failure
      return {
        data: {
          ...data,
          connectorTransactionId: res.connectorTransactionId ?? null,
          prismStatus: res.status,
          raw: res,
        },
        status: this.mapPrismPaymentStatus(res.status),
      }
    } catch (error) {
      throw this.buildError("An error occurred in authorizePayment", error)
    }
  }

  // ── capturePayment ────────────────────────────────────────────────────────

  async capturePayment({
    data,
    amount,
    context,
  }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as string
    const currency = (data as any)?.currency as string

    try {
      const res = await this.paymentClient_.capture({
        merchantCaptureId:
          (context?.idempotency_key as string) ?? `capt_${Date.now()}`,
        connectorTransactionId,
        amountToCapture: {
          minorAmount: toMinorAmount(Number(amount), currency),
          currency: currency.toUpperCase() as types.Currency,
        },
      })

      return {
        data: { ...data, captureStatus: res.status, raw: res },
      }
    } catch (error) {
      throw this.buildError("An error occurred in capturePayment", error)
    }
  }

  // ── refundPayment ─────────────────────────────────────────────────────────
  // Uses RefundStatus enum — NOT PaymentStatus.
  // REFUND_SUCCESS = 4 (≠ AUTHENTICATION_PENDING = 4 in PaymentStatus)

  async refundPayment({
    data,
    amount,
    context,
  }: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as string
    const currency = (data as any)?.currency as string

    try {
      const res = await this.paymentClient_.refund({
        merchantRefundId:
          (context?.idempotency_key as string) ?? `ref_${Date.now()}`,
        connectorTransactionId,
        refundAmount: {
          minorAmount: toMinorAmount(Number(amount), currency),
          currency: currency.toUpperCase() as types.Currency,
        },
      })

      if (res.status === PrismRefundStatus.REFUND_FAILURE) {
        throw this.buildError(
          "Refund failed at connector",
          new Error((res as any).error?.message ?? "Unknown refund error")
        )
      }

      return { data: { ...data, refundStatus: res.status, raw: res } }
    } catch (error) {
      throw this.buildError("An error occurred in refundPayment", error)
    }
  }

  // ── cancelPayment ─────────────────────────────────────────────────────────

  async cancelPayment({
    data,
    context,
  }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as string
    if (!connectorTransactionId) {
      // Not yet authorized — nothing to void
      return { data }
    }

    try {
      await this.paymentClient_.void({
        merchantVoidId:
          (context?.idempotency_key as string) ?? `void_${Date.now()}`,
        connectorTransactionId,
      })
      return { data }
    } catch (error) {
      throw this.buildError("An error occurred in cancelPayment", error)
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input)
  }

  // ── getPaymentStatus ──────────────────────────────────────────────────────

  async getPaymentStatus({
    data,
  }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as string
    if (!connectorTransactionId) {
      return { data, status: PaymentSessionStatus.PENDING }
    }

    try {
      const res = await this.paymentClient_.sync({ connectorTransactionId })
      return {
        data: { ...data, raw: res },
        status: this.mapPrismPaymentStatus(res.status),
      }
    } catch (error) {
      throw this.buildError("An error occurred in getPaymentStatus", error)
    }
  }

  async retrievePayment({
    data,
  }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as string
    const res = await this.paymentClient_.get({ connectorTransactionId })
    return { data: { ...data, raw: res } }
  }

  // ── updatePayment ─────────────────────────────────────────────────────────
  // Prism has no update API — void + re-initiate is the only approach.

  async updatePayment({
    data,
    currency_code,
    amount,
    context,
  }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    await this.cancelPayment({ data, context })
    return this.initiatePayment({
      currency_code,
      amount,
      data,
      context,
    }) as Promise<UpdatePaymentOutput>
  }

  // ── getWebhookActionAndData ───────────────────────────────────────────────
  // eventClient.handleEvent() verifies signature and returns normalized event.

  async getWebhookActionAndData(
    webhookData: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    try {
      const res = await this.eventClient_.handleEvent({
        rawBody: Buffer.from(webhookData.rawData as string),
        webhookSecret: this.options_.webhookSecret ?? "",
        ...Object.fromEntries(
          Object.entries(webhookData.headers).map(([k, v]) => [k.toLowerCase(), v])
        ),
      })

      const status = (res as any).status as number | undefined
      if (!status) return { action: PaymentActions.NOT_SUPPORTED }

      const transactionId = ((res as any).connectorTransactionId as string) ?? ""

      switch (status) {
        case PrismPaymentStatus.AUTHORIZED: // 6
          return {
            action: PaymentActions.AUTHORIZED,
            data: { session_id: transactionId, amount: 0 },
          }
        case PrismPaymentStatus.CHARGED: // 8
          return {
            action: PaymentActions.SUCCESSFUL,
            data: { session_id: transactionId, amount: 0 },
          }
        case PrismPaymentStatus.AUTHENTICATION_PENDING: // 4
          return {
            action: PaymentActions.REQUIRES_MORE,
            data: { session_id: transactionId, amount: 0 },
          }
        case PrismPaymentStatus.VOIDED: // 11
          return {
            action: PaymentActions.CANCELED,
            data: { session_id: transactionId, amount: 0 },
          }
        case PrismPaymentStatus.AUTHORIZATION_FAILED: // 7
        case PrismPaymentStatus.FAILURE: // 21
          return {
            action: PaymentActions.FAILED,
            data: { session_id: transactionId, amount: 0 },
          }
        default:
          return { action: PaymentActions.NOT_SUPPORTED }
      }
    } catch (error) {
      throw this.buildError("An error occurred in getWebhookActionAndData", error)
    }
  }
}

export default HyperswitchPrismProviderService
```

---

## 6. `src/index.ts`

```typescript
import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import HyperswitchPrismProviderService from "./services/hyperswitch-prism"

const services = [HyperswitchPrismProviderService]

export default ModuleProvider(Modules.PAYMENT, { services })
```

---

## 7. Registration in `medusa-config.ts`

```typescript
import { Modules } from "@medusajs/framework/utils"

// Stripe via Prism
{
  resolve: "@medusajs/payment-hyperswitch-prism",
  id: "hyperswitch-prism",
  options: {
    connector: "stripe",
    connectorConfig: {
      apiKey: { value: process.env.STRIPE_API_KEY },  // { value: "..." } is required format
    },
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    environment: "SANDBOX",
    capture: false,
  },
}

// Adyen via Prism (requires browserInfo in payment session data)
{
  resolve: "@medusajs/payment-hyperswitch-prism",
  id: "hyperswitch-prism-adyen",
  options: {
    connector: "adyen",
    connectorConfig: {
      apiKey: { value: process.env.ADYEN_API_KEY },
      merchantAccount: { value: process.env.ADYEN_MERCHANT_ACCOUNT },
    },
    environment: "SANDBOX",
    capture: false,
  },
}
```

---

## 8. How the Storefront Passes Card Data

Since Prism needs raw card data at `authorize()` time, the storefront sends it when creating the payment session:

```typescript
// POST /store/payment-collections/:id/payment-sessions
{
  "provider_id": "hyperswitch-prism_hyperswitch-prism",
  "data": {
    "paymentMethod": {
      "card": {
        "cardNumber": { "value": "4111111111111111" },
        "cardExpMonth": { "value": "12" },
        "cardExpYear": { "value": "2027" },
        "cardCvc": { "value": "123" },
        "cardHolderName": { "value": "Jane Doe" }
      }
    },
    "authType": 1,      // types.AuthenticationType.NO_THREE_DS = 1
    "testMode": true
  }
}
```

This `data` flows: `initiatePayment` (stored in `session.data`) → `authorizePayment` (used to call Prism).

> **PCI Note:** Passing raw card numbers through Medusa's API requires the backend to be PCI-DSS compliant (SAQ D level). For production, use a processor-specific JS tokenization SDK on the frontend and pass only the resulting token through this flow.

---

## 9. Connector Config Formats (Common Connectors)

| Connector | `connectorConfig` shape |
|---|---|
| Stripe | `{ apiKey: { value: "sk_..." } }` |
| Adyen | `{ apiKey: { value: "..." }, merchantAccount: { value: "..." } }` |
| PayPal | `{ clientId: { value: "..." }, clientSecret: { value: "..." } }` |
| Checkout.com | `{ apiKey: { value: "..." } }` |
| Cybersource | `{ username: { value: "..." }, password: { value: "..." } }` |

All credential values must be wrapped in `{ value: "..." }` — **not** bare strings.

---

## 10. Status Code Reference

### PaymentStatus (numeric) → Medusa PaymentSessionStatus

| Prism Value | Constant | Medusa Status |
|---|---|---|
| 6 | `AUTHORIZED` | `AUTHORIZED` |
| 8 | `CHARGED` | `CAPTURED` |
| 4 | `AUTHENTICATION_PENDING` | `REQUIRES_MORE` |
| 20 | `PENDING` | `PENDING` |
| 11 | `VOIDED` | `CANCELED` |
| 7 | `AUTHORIZATION_FAILED` | `ERROR` |
| 21 | `FAILURE` | `ERROR` |

### RefundStatus (separate enum — do NOT confuse with PaymentStatus)

| Prism Value | Constant | Meaning |
|---|---|---|
| 1 | `REFUND_FAILURE` | Refund failed |
| 2 | `REFUND_MANUAL_REVIEW` | Pending manual review |
| 3 | `REFUND_PENDING` | Refund in progress |
| 4 | `REFUND_SUCCESS` | Refund completed |

---

## 11. Files to Create (Summary)

| File | Action |
|---|---|
| `packages/modules/providers/payment-hyperswitch-prism/package.json` | Create |
| `packages/modules/providers/payment-hyperswitch-prism/tsconfig.json` | Create |
| `packages/modules/providers/payment-hyperswitch-prism/src/index.ts` | Create |
| `packages/modules/providers/payment-hyperswitch-prism/src/services/hyperswitch-prism.ts` | Create |
| `packages/modules/providers/payment-hyperswitch-prism/src/types/index.ts` | Create |
| `packages/modules/providers/payment-hyperswitch-prism/src/utils/get-amount.ts` | Create |

No existing Medusa files need modification — this is a standalone new package.

---

## 12. Verification Steps

1. `cd packages/modules/providers/payment-hyperswitch-prism && yarn build` — must compile with no errors
2. Register provider in `medusa-config.ts` with Stripe sandbox `apiKey: { value: "sk_test_..." }`
3. `yarn dev` → confirm provider registers in DB as `pp_hyperswitch-prism_hyperswitch-prism`
4. `POST /store/payment-collections` → create collection for a cart
5. `POST /store/payment-collections/:id/payment-sessions` with Stripe test card in `data.paymentMethod` → `initiatePayment` creates PENDING session, stores card data
6. Complete checkout → `authorizePayment` calls Prism `client.authorize()` → session becomes AUTHORIZED (status 6)
7. `POST /admin/payments/:id/capture` → `capturePayment` calls Prism `client.capture()` → CHARGED (status 8)
8. `POST /admin/payments/:id/refund` → `refundPayment` calls Prism `client.refund()` → REFUND_SUCCESS (refund status 4)
