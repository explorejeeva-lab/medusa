export interface HyperswitchPrismOptions {
  connector: "stripe" | "globalpay"
  connectorConfig: Record<string, unknown>
  webhookSecret?: string
  environment?: "SANDBOX" | "PRODUCTION"
  capture?: boolean
}

export interface HyperswitchPrismStripeOptions extends HyperswitchPrismOptions {
  connector: "stripe"
  connectorConfig: { apiKey: { value: string } }
}

export interface HyperswitchPrismGlobalpayOptions extends HyperswitchPrismOptions {
  connector: "globalpay"
  connectorConfig: {
    appId: { value: string }
    appKey: { value: string }
    baseUrl?: string
  }
}

// Use types.PaymentStatus and types.RefundStatus from the hyperswitch-prism SDK directly.
