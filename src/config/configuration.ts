/**
 * Typed configuration, read from the environment once per app instance.
 * There are no defaults here: every value lives in `.env.local` /
 * `.env.production` (or the host's environment), and both files declare the
 * same variables.
 *
 * Every environment runs the same stack: PostgreSQL, Redis, Bachs, Cloudinary
 * and SMTP (development points them at sandboxes and test accounts). Money
 * never moves inside DOOAA: charges, refunds and seller payouts are always
 * executed by Bachs. The test suite swaps the external services for
 * in-memory doubles through dependency injection, not configuration.
 */

export type NodeEnv = 'development' | 'production' | 'test';
export type SmsDriver = 'termii' | 'memory' | 'log';

export interface AppConfig {
  env: NodeEnv;
  port: number;
  /** Public base URL of this API including the /api/v1 prefix, used for links it hands out (media). */
  apiUrl: string;
  platformUrl: string;
  adminUrl: string;
  corsOrigins: string[];
  logLevel: string;
  /** Serve the API docs at /docs. */
  swaggerEnabled: boolean;
  database: {
    /** MongoDB connection string (Atlas or local). */
    url: string;
    /** Database name inside the cluster. */
    name: string;
    poolMax: number;
  };
  redis: {
    url: string;
    /** Prepended to every key, so several apps or environments can share one Redis. */
    keyPrefix: string;
  };
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    staffSecret: string;
    /** Seconds. */
    accessTtl: number;
    staffAccessTtl: number;
    refreshTtlDays: number;
    staffRefreshTtlDays: number;
  };
  otp: {
    ttlSeconds: number;
    resendCooldownSeconds: number;
    maxAttempts: number;
    /** Development only: a fixed code accepted alongside the real one. Ignored in production. */
    devCode?: string;
    pepper: string;
  };
  auth: { maxFailedSignIns: number; lockMinutes: number; bcryptRounds: number; cookieSameSite: 'lax' | 'strict' | 'none'; cookieSecure: boolean };
  mail: {
    /** The From header, e.g. `DOOAA <no-reply@dooaa.ng>`. */
    from: string;
    supportInbox: string;
    smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string };
  };
  sms: {
    driver: SmsDriver;
    termii: { apiKey?: string; senderId: string; baseUrl: string };
  };
  storage: {
    maxImageMb: number;
    maxVideoMb: number;
    maxFileMb: number;
    signingSecret: string;
    cloudinary: { cloudName: string; apiKey: string; apiSecret: string; folder: string };
  };
  payments: {
    currency: 'NGN';
    /** Where Bachs sends the buyer after paying; the client verifies from there. */
    callbackUrl: string;
    bachs: {
      secretKey: string;
      /** Signs the webhooks Bachs sends; from the Bachs dashboard's webhook settings. */
      webhookSecret: string;
      baseUrl: string;
    };
  };
  throttle: { ttlMs: number; limit: number; authLimit: number };
  scheduler: { enabled: boolean };
}

/**
 * Every setting comes from the environment (`.env.local` / `.env.production`);
 * nothing is defaulted in code. A variable that is not declared at all is
 * collected and reported at once, so a missing line in an env file fails the
 * boot instead of silently picking a value.
 */
const undeclared: string[] = [];

function raw(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    undeclared.push(name);
    return '';
  }
  return value.trim();
}

/** A required value: must be declared and non-empty. */
function str(name: string): string {
  const value = raw(name);
  if (value === '' && !undeclared.includes(name)) undeclared.push(`${name} (empty)`);
  return value;
}

/** Must be declared, but may be left empty (an integration that is switched off). */
function opt(name: string): string | undefined {
  return raw(name) || undefined;
}

function num(name: string): number {
  const value = str(name);
  const parsed = Number(value);
  if (value !== '' && !Number.isFinite(parsed)) undeclared.push(`${name} (not a number)`);
  return parsed;
}

function bool(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(str(name).toLowerCase());
}

function oneOf<T extends string>(name: string, allowed: readonly T[]): T {
  const value = str(name) as T;
  if (value && !allowed.includes(value)) undeclared.push(`${name} (one of ${allowed.join(', ')})`);
  return value;
}

const url = (name: string) => str(name).replace(/\/$/, '');

export function loadConfig(): AppConfig {
  undeclared.length = 0;
  const env = oneOf<NodeEnv>('NODE_ENV', ['development', 'production', 'test']);
  const production = env === 'production';
  const otpDevCode = opt('OTP_DEV_CODE');
  const platformUrl = url('PLATFORM_URL');
  const adminUrl = url('ADMIN_URL');
  const extraOrigins = (opt('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const config: AppConfig = {
    env,
    port: num('PORT'),
    apiUrl: url('API_URL'),
    platformUrl,
    adminUrl,
    corsOrigins: Array.from(new Set([platformUrl, adminUrl, ...extraOrigins])),
    logLevel: str('LOG_LEVEL'),
    swaggerEnabled: bool('SWAGGER_ENABLED'),
    database: {
      url: str('MONGODB_URI'),
      name: str('MONGODB_DB'),
      poolMax: num('DATABASE_POOL_MAX'),
    },
    redis: {
      url: opt('REDIS_URL') ?? '',
      keyPrefix: str('REDIS_KEY_PREFIX'),
    },
    jwt: {
      accessSecret: str('JWT_ACCESS_SECRET'),
      refreshSecret: str('JWT_REFRESH_SECRET'),
      staffSecret: str('JWT_STAFF_SECRET'),
      accessTtl: num('JWT_ACCESS_TTL_SECONDS'),
      staffAccessTtl: num('JWT_STAFF_ACCESS_TTL_SECONDS'),
      refreshTtlDays: num('JWT_REFRESH_TTL_DAYS'),
      staffRefreshTtlDays: num('JWT_STAFF_REFRESH_TTL_DAYS'),
    },
    otp: {
      ttlSeconds: num('OTP_TTL_SECONDS'),
      resendCooldownSeconds: num('OTP_RESEND_COOLDOWN_SECONDS'),
      maxAttempts: num('OTP_MAX_ATTEMPTS'),
      devCode: production ? undefined : otpDevCode,
      pepper: str('OTP_PEPPER'),
    },
    auth: {
      maxFailedSignIns: num('AUTH_MAX_FAILED_SIGNINS'),
      lockMinutes: num('AUTH_LOCK_MINUTES'),
      bcryptRounds: num('BCRYPT_ROUNDS'),
      cookieSameSite: oneOf<'lax' | 'strict' | 'none'>('COOKIE_SAMESITE', ['lax', 'strict', 'none']),
      cookieSecure: bool('COOKIE_SECURE'),
    },
    mail: {
      from: str('SMTP_FROM'),
      supportInbox: str('SUPPORT_INBOX'),
      smtp: {
        host: opt('SMTP_HOST') ?? '',
        port: num('SMTP_PORT'),
        secure: bool('SMTP_SECURE'),
        user: opt('SMTP_USER'),
        pass: opt('SMTP_PASS'),
      },
    },
    sms: {
      driver: oneOf<SmsDriver>('SMS_DRIVER', ['termii', 'memory', 'log']),
      termii: {
        apiKey: opt('TERMII_API_KEY'),
        senderId: str('TERMII_SENDER_ID'),
        baseUrl: url('TERMII_BASE_URL'),
      },
    },
    storage: {
      maxImageMb: num('MAX_IMAGE_MB'),
      maxVideoMb: num('MAX_VIDEO_MB'),
      maxFileMb: num('MAX_FILE_MB'),
      signingSecret: str('MEDIA_SIGNING_SECRET'),
      cloudinary: {
        cloudName: opt('CLOUDINARY_CLOUD_NAME') ?? '',
        apiKey: opt('CLOUDINARY_API_KEY') ?? '',
        apiSecret: opt('CLOUDINARY_API_SECRET') ?? '',
        folder: str('CLOUDINARY_FOLDER'),
      },
    },
    payments: {
      currency: 'NGN',
      callbackUrl: url('PAYMENT_CALLBACK_URL'),
      bachs: {
        secretKey: opt('BACHS_SECRET_KEY') ?? '',
        webhookSecret: opt('BACHS_WEBHOOK_SECRET') ?? '',
        baseUrl: url('BACHS_BASE_URL'),
      },
    },
    throttle: {
      ttlMs: num('THROTTLE_TTL_MS'),
      limit: num('THROTTLE_LIMIT'),
      authLimit: num('AUTH_THROTTLE_LIMIT'),
    },
    scheduler: { enabled: bool('SCHEDULER_ENABLED') },
  };

  if (undeclared.length) {
    throw new Error(`These variables are missing from the ${env} env file: ${undeclared.join(', ')}`);
  }
  return config;
}

/**
 * Fails fast at boot only when something the app cannot run without is
 * missing: the database everywhere, and real secrets in production. Missing
 * integration keys (Redis, SMTP, Cloudinary, Bachs, Termii) are logged as
 * warnings instead: the server still starts and only the features that need
 * them fail when used. The test suite replaces the services with in-memory
 * doubles, so it only needs the database.
 */
export function assertConfig(config: AppConfig): void {
  const missing: string[] = [];
  const optional: string[] = [];
  const need = (value: unknown, name: string) => {
    if (!value) missing.push(name);
  };
  const want = (value: unknown, name: string) => {
    if (!value) optional.push(name);
  };
  need(config.database.url, 'MONGODB_URI');
  if (config.env !== 'test') {
    want(config.redis.url, 'REDIS_URL');
    want(config.mail.smtp.host, 'SMTP_HOST');
    want(config.storage.cloudinary.cloudName, 'CLOUDINARY_CLOUD_NAME');
    want(config.storage.cloudinary.apiKey, 'CLOUDINARY_API_KEY');
    want(config.storage.cloudinary.apiSecret, 'CLOUDINARY_API_SECRET');
    want(config.payments.bachs.secretKey, 'BACHS_SECRET_KEY');
    want(config.payments.bachs.webhookSecret, 'BACHS_WEBHOOK_SECRET');
  }
  if (config.env === 'production') {
    need(config.jwt.accessSecret, 'JWT_ACCESS_SECRET');
    need(config.jwt.refreshSecret, 'JWT_REFRESH_SECRET');
    need(config.jwt.staffSecret, 'JWT_STAFF_SECRET');
    need(config.otp.pepper, 'OTP_PEPPER');
    need(config.storage.signingSecret, 'MEDIA_SIGNING_SECRET');
    if (config.sms.driver === 'termii') want(config.sms.termii.apiKey, 'TERMII_API_KEY');
    // A placeholder key only breaks payments, not the rest of the API, so it warns like the other integrations.
    if (config.payments.bachs.secretKey && !config.payments.bachs.secretKey.startsWith('sk_live_')) {
      optional.push('BACHS_SECRET_KEY (production needs a live key, sk_live_…)');
    }
    for (const [name, secret] of [
      ['JWT_ACCESS_SECRET', config.jwt.accessSecret],
      ['JWT_REFRESH_SECRET', config.jwt.refreshSecret],
      ['JWT_STAFF_SECRET', config.jwt.staffSecret],
    ] as const) {
      if (secret && secret.length < 32) missing.push(`${name} (must be at least 32 characters)`);
    }
  }
  if (optional.length) {
    console.warn(`[config] The server is starting without some settings, so a few features will not work until they are added to the .env file: ${optional.join(', ')}.`);
  }
  if (missing.length) {
    throw new Error(`Missing ${config.env} configuration: ${missing.join(', ')}`);
  }
}

/** Injection token for the typed config object. */
export const APP_CONFIG = Symbol('APP_CONFIG');
