export interface HyperswitchPrismOptions {
  connector: "stripe" | "adyen"
  connectorConfig: Record<string, unknown>
  webhookSecret?: string
  environment?: "SANDBOX" | "PRODUCTION"
  capture?: boolean
}

export interface HyperswitchPrismStripeOptions extends HyperswitchPrismOptions {
  connector: "stripe"
  connectorConfig: { apiKey: { value: string } }
}

export interface HyperswitchPrismAdyenOptions extends HyperswitchPrismOptions {
  connector: "adyen"
  connectorConfig: {
    apiKey: { value: string }
    merchantAccount: { value: string }
  }
}


// Use types.PaymentStatus and types.RefundStatus from the hyperswitch-prism SDK directly.
