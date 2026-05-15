import {
  PaymentClient,
  MerchantAuthenticationClient,
  EventClient,
  IntegrationError,
  ConnectorError,
  types,
} from "hyperswitch-prism"
import {
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { PaymentActions, PaymentSessionStatus, isDefined } from "@medusajs/framework/utils"
import { HyperswitchPrismGlobalpayOptions } from "../types"
import { toMinorAmount, fromMinorAmount } from "../utils"

type PrismConfig = {
  connectorConfig: Record<string, unknown>
  options: { environment: types.Environment }
}


class GlobalpayService {
  private paymentClient_: PaymentClient
  private authClient_: MerchantAuthenticationClient
  private eventClient_: EventClient
  private options_: HyperswitchPrismGlobalpayOptions

  constructor(options: HyperswitchPrismGlobalpayOptions) {
    this.options_ = options
    const prismConfig: PrismConfig = {
      connectorConfig: { globalpay: options.connectorConfig },
      options: {
        environment:
          options.environment === "PRODUCTION"
            ? types.Environment.PRODUCTION
            : types.Environment.SANDBOX,
      },
    }
    this.paymentClient_ = new PaymentClient(prismConfig as types.IConnectorConfig)
    this.authClient_ = new MerchantAuthenticationClient(
      prismConfig as types.IConnectorConfig
    )
    this.eventClient_ = new EventClient(prismConfig as types.IConnectorConfig)
  }

  private toCurrency(currencyCode: string): types.Currency {
    const key = currencyCode.toUpperCase() as keyof typeof types.Currency
    return (types.Currency[key] ??
      types.Currency.CURRENCY_UNSPECIFIED) as unknown as types.Currency
  }

  private mapPrismStatus(status: number): PaymentSessionStatus {
    const { PaymentStatus } = types
    switch (status) {
      case PaymentStatus.AUTHORIZED:
      case PaymentStatus.PARTIALLY_AUTHORIZED:
        return PaymentSessionStatus.AUTHORIZED
      case PaymentStatus.CHARGED:
      case PaymentStatus.PARTIAL_CHARGED:
      case PaymentStatus.PARTIAL_CHARGED_AND_CHARGEABLE:
        return PaymentSessionStatus.CAPTURED
      case PaymentStatus.AUTHENTICATION_PENDING:
      case PaymentStatus.CONFIRMATION_AWAITED:
      case PaymentStatus.PAYMENT_METHOD_AWAITED:
      case PaymentStatus.DEVICE_DATA_COLLECTION_PENDING:
        return PaymentSessionStatus.REQUIRES_MORE
      case PaymentStatus.VOIDED:
      case PaymentStatus.VOID_INITIATED:
      case PaymentStatus.VOIDED_POST_CAPTURE:
        return PaymentSessionStatus.CANCELED
      case PaymentStatus.AUTHORIZATION_FAILED:
      case PaymentStatus.AUTHENTICATION_FAILED:
      case PaymentStatus.CAPTURE_FAILED:
      case PaymentStatus.VOID_FAILED:
      case PaymentStatus.FAILURE:
      case PaymentStatus.ROUTER_DECLINED:
        return PaymentSessionStatus.ERROR
      default:
        return PaymentSessionStatus.PENDING
    }
  }

  buildError(message: string, error: unknown): Error {
    if (error instanceof IntegrationError) {
      return new Error(
        `[Hyperswitch Prism] ${message}: ${error.message} (code: ${error.errorCode})`
      )
    }
    if (error instanceof ConnectorError) {
      return new Error(
        `[Hyperswitch Prism] ${message}: ${error.message} (http: ${error.httpStatusCode})`
      )
    }
    return new Error(
      `[Hyperswitch Prism] ${message}: ${(error as Error).message}`
    )
  }

  async initiatePayment({
    currency_code,
    amount,
    data,
    context,
  }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const merchantClientSessionId =
      (context?.idempotency_key as string) ??
      (data?.session_id as string) ??
      `hs_${Date.now()}`
    const minorAmount = toMinorAmount(Number(amount), currency_code)
    const currency = this.toCurrency(currency_code)

    try {
      const res = await this.authClient_.createClientAuthenticationToken({
        merchantClientSessionId,
        payment: {
          amount: {
            minorAmount,
            currency,
          },
        },
        // GlobalPay requires explicit permission to create a payment
        permissions: {
          codes: ["PMT_POST_Create_Single"],
        },
      } as any)

      const statusCode = (res as any).statusCode as number | undefined
      if (statusCode !== undefined && statusCode !== 200) {
        throw new Error(
          (res as any).error?.message ?? "createClientAuthenticationToken failed"
        )
      }

      const accessToken =
        (res as any).accessToken ??
        (res as any).access_token ??
        null

      return {
        id: merchantClientSessionId,
        data: {
          accessToken,
          tokenType: (res as any).tokenType ?? (res as any).token_type,
          expiresIn: (res as any).expiresIn ?? (res as any).expires_in,
          minorAmount,
          currency: currency_code,
          merchantClientSessionId,
          connector: "globalpay",
        },
        status: PaymentSessionStatus.PENDING,
      }
    } catch (error) {
      throw this.buildError("An error occurred in initiatePayment", error)
    }
  }

  // GlobalPay requires an explicit authorize call after the frontend collects the payment token
  async authorize({
    data,
    context,
  }: { data: Record<string, unknown>; context?: Record<string, unknown> }): Promise<{ data: Record<string, unknown>; status: PaymentSessionStatus }> {
    try {
      const res = await (this.paymentClient_ as any).authorize({
        merchantTransactionId: (data as any).merchantClientSessionId,
        amount: {
          minorAmount: (data as any).minorAmount,
          currency: this.toCurrency((data as any).currency as string),
        },
        captureMethod: this.options_.capture
          ? types.CaptureMethod.AUTOMATIC
          : types.CaptureMethod.MANUAL,
        paymentMethod: (data as any).paymentMethod,
      })

      const connectorTransactionId =
        (res as any).connectorTransactionId ??
        (res as any).connector_transaction_id

      return {
        data: { ...(data as any), connectorTransactionId, raw: res },
        status: this.mapPrismStatus(
          (res as any).status ?? types.PaymentStatus.PAYMENT_STATUS_UNSPECIFIED
        ),
      }
    } catch (error) {
      throw this.buildError("An error occurred in authorizePayment", error)
    }
  }

  async getPaymentStatus({
    data,
  }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as
      | string
      | undefined
    if (!connectorTransactionId) {
      return { data, status: PaymentSessionStatus.PENDING }
    }

    const minorAmount = (data as any)?.minorAmount as number | undefined
    const currency = (data as any)?.currency as string | undefined

    try {
      const res = await this.paymentClient_.get({
        connectorTransactionId,
        ...(minorAmount !== undefined && currency
          ? { amount: { minorAmount, currency: this.toCurrency(currency) } }
          : {}),
      })
      const status = (res as any).status as number | undefined
      return {
        data: { ...(data as any), prismStatus: status, raw: res },
        status: this.mapPrismStatus(status ?? types.PaymentStatus.PAYMENT_STATUS_UNSPECIFIED),
      }
    } catch (error) {
      throw this.buildError("An error occurred in getPaymentStatus", error)
    }
  }

  async capture({
    data,
    context,
  }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as string

    try {
      const res = await this.paymentClient_.capture({
        merchantCaptureId:
          (context?.idempotency_key as string) ?? `capt_${Date.now()}`,
        connectorTransactionId,
      })
      return {
        data: { ...(data as any), captureStatus: (res as any).status, raw: res },
      }
    } catch (error) {
      throw this.buildError("An error occurred in capturePayment", error)
    }
  }

  async refund({
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
          currency: this.toCurrency(currency),
        },
      })

      const refundStatus = (res as any).status as number | undefined
      if (
        refundStatus === types.RefundStatus.REFUND_FAILURE ||
        refundStatus === types.RefundStatus.REFUND_TRANSACTION_FAILURE
      ) {
        throw new Error(
          (res as any).error?.message ?? "Refund failed at connector"
        )
      }

      return { data: { ...(data as any), refundStatus, raw: res } }
    } catch (error) {
      throw this.buildError("An error occurred in refundPayment", error)
    }
  }

  async cancel({
    data,
    context,
  }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as
      | string
      | undefined
    if (!connectorTransactionId) {
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
      // Treat 400 from connector as a no-op — payment is already in a terminal state
      if (error instanceof ConnectorError && error.httpStatusCode === 400) {
        return { data }
      }
      throw this.buildError("An error occurred in cancelPayment", error)
    }
  }

  async retrieve({
    data,
  }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const connectorTransactionId = (data as any)?.connectorTransactionId as string
    const currency = (data as any)?.currency as string
    const minorAmount = (data as any)?.minorAmount as number | undefined
    try {
      const res = await this.paymentClient_.get({
        connectorTransactionId,
        ...(minorAmount !== undefined && currency
          ? { amount: { minorAmount, currency: this.toCurrency(currency) } }
          : {}),
      })
      const rawAmount = (res as any)?.amount?.minorAmount as number | undefined
      if (rawAmount !== undefined && currency) {
        ;(res as any).amount = fromMinorAmount(rawAmount, currency)
      }
      return { data: { ...(data as any), raw: res } }
    } catch (error) {
      throw this.buildError("An error occurred in retrievePayment", error)
    }
  }

  async handleWebhook(
    webhookData: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    try {
      const rawBody =
        typeof webhookData.rawData === "string"
          ? Buffer.from(webhookData.rawData)
          : (webhookData.rawData as Buffer)

      const lowercasedHeaders = Object.fromEntries(
        Object.entries(webhookData.headers).map(([k, v]) => [k.toLowerCase(), v])
      ) as { [k: string]: string }

      const res = await this.eventClient_.handleEvent({
        requestDetails: {
          method: types.HttpMethod.HTTP_METHOD_POST,
          headers: lowercasedHeaders,
          body: rawBody,
        },
        webhookSecrets: {
          secret: this.options_.webhookSecret ?? "",
        },
      })

      const eventType = (res as any).eventType as number | undefined
      if (!isDefined(eventType)) {
        return { action: PaymentActions.NOT_SUPPORTED }
      }

      const paymentsResponse = (res as any).eventContent
        ?.paymentsResponse as Record<string, any> | undefined

      // merchantTransactionId = merchantClientSessionId from initiatePayment (= Medusa session ID)
      const sessionId =
        (paymentsResponse?.merchantTransactionId as string | undefined) ??
        (paymentsResponse?.connectorTransactionId as string | undefined) ??
        ""

      const rawAmount = paymentsResponse?.amount?.minorAmount as
        | number
        | undefined
      const currency = paymentsResponse?.amount?.currency as string | undefined
      const amount =
        rawAmount !== undefined && currency
          ? fromMinorAmount(rawAmount, currency.toLowerCase())
          : 0

      const { WebhookEventType } = types

      switch (eventType) {
        case WebhookEventType.PAYMENT_INTENT_AUTHORIZATION_SUCCESS:
          return {
            action: PaymentActions.AUTHORIZED,
            data: { session_id: sessionId, amount },
          }
        case WebhookEventType.PAYMENT_INTENT_SUCCESS:
        case WebhookEventType.PAYMENT_INTENT_CAPTURE_SUCCESS:
          return {
            action: PaymentActions.SUCCESSFUL,
            data: { session_id: sessionId, amount },
          }
        case WebhookEventType.PAYMENT_ACTION_REQUIRED:
          return {
            action: PaymentActions.REQUIRES_MORE,
            data: { session_id: sessionId, amount },
          }
        case WebhookEventType.PAYMENT_INTENT_PROCESSING:
          return {
            action: PaymentActions.PENDING,
            data: { session_id: sessionId, amount },
          }
        case WebhookEventType.PAYMENT_INTENT_CANCELLED:
          return {
            action: PaymentActions.CANCELED,
            data: { session_id: sessionId, amount },
          }
        case WebhookEventType.PAYMENT_INTENT_FAILURE:
        case WebhookEventType.PAYMENT_INTENT_AUTHORIZATION_FAILURE:
        case WebhookEventType.PAYMENT_INTENT_CAPTURE_FAILURE:
          return {
            action: PaymentActions.FAILED,
            data: { session_id: sessionId, amount },
          }
        default:
          return { action: PaymentActions.NOT_SUPPORTED }
      }
    } catch (error) {
      throw this.buildError(
        "An error occurred in getWebhookActionAndData",
        error
      )
    }
  }
}

export default GlobalpayService
