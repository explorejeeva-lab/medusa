import {
  AbstractPaymentProvider,
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
import { HyperswitchPrismOptions } from "../types"
import StripeService from "../services/stripe"
import GlobalpayService from "../services/globalpay"

class HyperswitchPrismBase extends AbstractPaymentProvider<HyperswitchPrismOptions> {
  static identifier = "hyperswitch-prism"

  protected options_: HyperswitchPrismOptions
  protected stripeService_: StripeService | null = null
  protected globalpayService_: GlobalpayService | null = null

  constructor(
    cradle: Record<string, unknown>,
    options: HyperswitchPrismOptions
  ) {
    // @ts-ignore
    super(...arguments)
    this.options_ = options
    if (options.connector === "stripe") {
      this.stripeService_ = new StripeService(options as any)
    } else {
      this.globalpayService_ = new GlobalpayService(options as any)
    }
  }

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

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    if (this.options_.connector === "stripe") {
      return this.stripeService_!.initiatePayment(input)
    }
    return this.globalpayService_!.initiatePayment(input)
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    if (this.options_.connector === "stripe") {
      return this.stripeService_!.authorizePayment(input)
    }
    return this.globalpayService_!.authorize(input as any) as Promise<AuthorizePaymentOutput>
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    if (this.options_.connector === "stripe") {
      return this.stripeService_!.getPaymentStatus(input)
    }
    return this.globalpayService_!.getPaymentStatus(input)
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    if (this.options_.connector === "stripe") {
      return this.stripeService_!.capture(input)
    }
    return this.globalpayService_!.capture(input)
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    if (this.options_.connector === "stripe") {
      return this.stripeService_!.refund(input)
    }
    return this.globalpayService_!.refund(input)
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    if (this.options_.connector === "stripe") {
      return this.stripeService_!.cancel(input)
    }
    return this.globalpayService_!.cancel(input)
  }

  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input)
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    if (this.options_.connector === "stripe") {
      return this.stripeService_!.retrieve(input)
    }
    return this.globalpayService_!.retrieve(input)
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    await this.cancelPayment(input)
    return this.initiatePayment(input) as Promise<UpdatePaymentOutput>
  }

  async getWebhookActionAndData(
    webhookData: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    if (this.options_.connector === "stripe") {
      return this.stripeService_!.handleWebhook(webhookData)
    }
    return this.globalpayService_!.handleWebhook(webhookData)
  }
}

export default HyperswitchPrismBase
