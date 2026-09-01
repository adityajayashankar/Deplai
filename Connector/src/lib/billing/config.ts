export const SALES_EMAIL = 'founders@deplai.tech';
export const BILLING_BRAND = 'DeplAI';

export type PaymentMode = 'test' | 'live';

export type PaymentRuntimeConfig = {
  enabled: boolean;
  provider: 'razorpay';
  mode: PaymentMode;
  testAmountOverride: boolean;
  allowLiveOneRupeeTest: boolean;
  testAmountPaise: number;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

export class PaymentConfigurationError extends Error {
  readonly code = 'invalid_payment_configuration';

  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigurationError';
  }
}

export type GstSplitKind = 'intra' | 'inter';

export type BillingSeller = {
  legalName: string;
  gstin: string;
  address: string;
  stateName: string;
  stateCode: string;
  sacCode: string;
  invoicePrefix: string;
  gstPercent: number;
  usdToInr: number;
};

function envString(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function envBoolean(name: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new PaymentConfigurationError(`${name} must be true or false`);
}

function paymentEnvString(name: string, env: NodeJS.ProcessEnv): string {
  return env[name]?.trim() || '';
}

/**
 * Central payment configuration. Calling this function is also the safety
 * boundary that prevents test pricing or test credentials from running live.
 */
export function paymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentRuntimeConfig {
  const provider = (paymentEnvString('PAYMENTS_PROVIDER', env) || 'razorpay').toLowerCase();
  const mode = (paymentEnvString('PAYMENTS_MODE', env) || 'test').toLowerCase();
  const enabled = envBoolean('PAYMENTS_ENABLED', true, env);
  const testAmountOverride = envBoolean('PAYMENTS_TEST_AMOUNT_OVERRIDE', true, env);
  const allowLiveOneRupeeTest = envBoolean('PAYMENTS_ALLOW_LIVE_ONE_RUPEE_TEST', false, env);
  const rawTestAmount = paymentEnvString('PAYMENTS_TEST_AMOUNT_PAISE', env) || '100';
  const testAmountPaise = Number(rawTestAmount);
  const keyId = paymentEnvString('RAZORPAY_KEY_ID', env);
  const keySecret = paymentEnvString('RAZORPAY_KEY_SECRET', env);
  const webhookSecret = paymentEnvString('RAZORPAY_WEBHOOK_SECRET', env);

  if (provider !== 'razorpay') {
    throw new PaymentConfigurationError('PAYMENTS_PROVIDER must be razorpay');
  }
  if (mode !== 'test' && mode !== 'live') {
    throw new PaymentConfigurationError('PAYMENTS_MODE must be test or live');
  }
  if (!Number.isInteger(testAmountPaise) || testAmountPaise < 100) {
    throw new PaymentConfigurationError('PAYMENTS_TEST_AMOUNT_PAISE must be an integer of at least 100 paise');
  }
  if (testAmountOverride && testAmountPaise !== 100) {
    throw new PaymentConfigurationError('DeplAI test checkout is fixed at exactly 100 paise');
  }
  if (mode === 'live' && testAmountOverride && !allowLiveOneRupeeTest) {
    throw new PaymentConfigurationError(
      'PAYMENTS_TEST_AMOUNT_OVERRIDE cannot be enabled in live mode without PAYMENTS_ALLOW_LIVE_ONE_RUPEE_TEST=true',
    );
  }
  if (keyId && mode === 'test' && !keyId.startsWith('rzp_test_')) {
    throw new PaymentConfigurationError('PAYMENTS_MODE=test requires a Razorpay test key');
  }
  if (keyId && mode === 'live' && !keyId.startsWith('rzp_live_')) {
    throw new PaymentConfigurationError('PAYMENTS_MODE=live requires a Razorpay live key');
  }

  return {
    enabled,
    provider: 'razorpay',
    mode,
    testAmountOverride,
    allowLiveOneRupeeTest,
    testAmountPaise,
    keyId,
    keySecret,
    webhookSecret,
  };
}

export function resolvePaymentAmountPaise(
  realAmountPaise: number,
  config: PaymentRuntimeConfig = paymentConfig(),
): number {
  if (!Number.isInteger(realAmountPaise) || realAmountPaise < 100) {
    throw new Error('Real payment amount must be an integer of at least 100 paise');
  }
  if (config.testAmountOverride) {
    return config.testAmountPaise;
  }
  return realAmountPaise;
}

export function publicPaymentConfig(config: PaymentRuntimeConfig = paymentConfig()) {
  return {
    enabled: config.enabled,
    provider: config.provider,
    mode: config.mode,
    testAmountOverride: config.testAmountOverride,
    testAmountPaise: config.testAmountOverride ? config.testAmountPaise : null,
  };
}

export function billingSeller(): BillingSeller {
  return {
    legalName: envString('BILLING_LEGAL_NAME', BILLING_BRAND),
    gstin: envString('BILLING_GSTIN'),
    address: envString('BILLING_ADDRESS'),
    stateName: envString('BILLING_STATE_NAME', 'Karnataka'),
    stateCode: envString('BILLING_STATE_CODE', '29'),
    sacCode: envString('BILLING_SAC_CODE', '998314'),
    invoicePrefix: envString('BILLING_INVOICE_PREFIX', 'DPL'),
    gstPercent: envNumber('BILLING_GST_RATE', 18),
    usdToInr: envNumber('RAZORPAY_USD_TO_INR', 95),
  };
}

export function isRazorpayConfigured(): boolean {
  try {
    const config = paymentConfig();
    return Boolean(config.enabled && config.keyId && config.keySecret);
  } catch {
    return false;
  }
}

export function publicRazorpayKeyId(): string {
  return paymentConfig().keyId;
}
