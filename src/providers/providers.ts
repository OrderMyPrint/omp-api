import { createHmac, randomBytes } from "node:crypto";
import { Logger } from "@nestjs/common";
import { safeEqual } from "../auth/crypto";

/**
 * External providers are chosen by decision: SMS for customer OTP (D-25) and the payment
 * gateway (D-06), both open. Until then only these development stand-ins exist, and they
 * refuse to run on a Vercel production deployment, so production checkout stays closed.
 */
export const isProductionDeployment = () => process.env.VERCEL_ENV === "production";

// ------------------------------------------------------------------ SMS

export interface SmsSender {
  readonly name: string;
  sendOtp(phoneE164: string, code: string): Promise<void>;
}

/** Writes the code to the server log. Development and tests only. */
export class ConsoleSms implements SmsSender {
  readonly name = "console";
  private readonly logger = new Logger("ConsoleSms");
  private readonly last = new Map<string, string>();

  async sendOtp(phoneE164: string, code: string) {
    this.last.set(phoneE164, code);
    this.logger.log(`OTP for ${phoneE164}: ${code} (development stand-in — no SMS sent)`);
  }

  /** For automated tests: the last code "sent" to a number. */
  lastCode(phoneE164: string) {
    return this.last.get(phoneE164);
  }
}

export const SMS_SENDER = "SMS_SENDER";

export function smsSenderFromEnv(): SmsSender | null {
  if (process.env.SMS_PROVIDER === "console" && !isProductionDeployment()) return new ConsoleSms();
  return null;
}

// ------------------------------------------------------------------ payments

export type PaymentAction = { type: "test"; completeUrl: string } | { type: "redirect"; url: string };

/** A verified gateway event, in the provider-neutral shape the order service understands. */
export type VerifiedPaymentEvent = {
  eventId: string;
  kind: "payment.captured" | "payment.failed";
  providerRef: string;
  amount: string;
  method?: string;
};

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: {
    orderNumber: string;
    amount: string;
  }): Promise<{ providerRef: string; action: PaymentAction }>;
  /** Returns the event when the signature is valid, otherwise null. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): VerifiedPaymentEvent | null;
}

const SIGNATURE_HEADER = "x-test-signature";

/**
 * Simulated gateway for development and tests. Its webhooks are HMAC-signed like a real
 * gateway's, so the same verification, idempotency and amount checks are exercised.
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = "test";
  private readonly secret = process.env.TEST_PAYMENT_SECRET || randomBytes(32).toString("hex");

  async createPayment() {
    return {
      providerRef: `testpay_${randomBytes(9).toString("base64url")}`,
      action: { type: "test" as const, completeUrl: "/api/v1/payments/test/complete" },
    };
  }

  sign(body: unknown) {
    return createHmac("sha256", this.secret).update(JSON.stringify(body)).digest("hex");
  }

  /** Builds a signed webhook as the gateway would send it. */
  event(kind: VerifiedPaymentEvent["kind"], providerRef: string, amount: string, eventId?: string) {
    const body = {
      id: eventId ?? `evt_${randomBytes(9).toString("base64url")}`,
      event: kind,
      payment: { id: providerRef, amount, method: "test" },
    };
    return { body, headers: { [SIGNATURE_HEADER]: this.sign(body) } };
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): VerifiedPaymentEvent | null {
    const signature = String(headers[SIGNATURE_HEADER] ?? "");
    if (!signature || !safeEqual(signature, this.sign(body))) return null;
    const b = body as { id?: unknown; event?: unknown; payment?: { id?: unknown; amount?: unknown; method?: unknown } };
    if (typeof b.id !== "string" || (b.event !== "payment.captured" && b.event !== "payment.failed")) return null;
    if (typeof b.payment?.id !== "string" || typeof b.payment.amount !== "string") return null;
    return {
      eventId: b.id,
      kind: b.event,
      providerRef: b.payment.id,
      amount: b.payment.amount,
      method: typeof b.payment.method === "string" ? b.payment.method : undefined,
    };
  }
}

export const PAYMENT_PROVIDERS = "PAYMENT_PROVIDERS";

/** Providers that can receive webhooks; the first is used for new payments. */
export function paymentProvidersFromEnv(): PaymentProvider[] {
  if (process.env.PAYMENT_PROVIDER === "test" && !isProductionDeployment()) return [new TestPaymentProvider()];
  return [];
}
