/**
 * Typed configuration, read from the environment once per app instance.
 *
 * Every environment runs the same stack: PostgreSQL, Redis, Bachs, Cloudinary
 * and SMTP (development points them at sandboxes and test accounts). Money
 * never moves inside DOOAA: charges, refunds and seller payouts are always
 * executed by Bachs. The test suite swaps the external services for
 * in-memory doubles through dependency injection, not configuration.
 */

export type NodeEnv = 'development' | 'production' | 'test';
export type SmsDriver = 'termii' | 'memory' | 'log';
/** `live` talks to Google/Facebook; `sandbox` signs in offline with a fake profile (development and tests). */
export type OAuthDriver = 'live' | 'sandbox';

export interface AppConfig {
  env: NodeEnv;
  port: number;
  /** Public base URL of this API, used for links it hands out (media, webhooks). */
  appUrl: string;
  clientUrl: string;
  adminUrl: string;
  corsOrigins: string[];
  logLevel: string;
  database: {
    url: string;
    poolMax: number;
    /** Server-side ceiling on any one statement, so a runaway query cannot hold a connection. */
    statementTimeoutMs: number;
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
  oauth: {
    driver: OAuthDriver;
    google: { clientId?: string; clientSecret?: string };
    facebook: { appId?: string; appSecret?: string; graphVersion: string };
  };
  throttle: { ttlMs: number; limit: number; authLimit: number };
  scheduler: { enabled: boolean };
  seed: {
    superadminEmail: string;
    superadminPassword?: string;
    superadminFirstName: string;
    superadminLastName: string;
  };
}

function str(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback === undefined) return '';
    return fallback;
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name] as T | undefined;
  return raw && allowed.includes(raw) ? raw : fallback;
}

/** Bachs keys say which environment they belong to; the base URL follows unless set explicitly. */
export function bachsBaseUrl(secretKey: string): string {
  return secretKey.startsWith('sk_live_') ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io';
}

export function loadConfig(): AppConfig {
  const env = oneOf<NodeEnv>('NODE_ENV', ['development', 'production', 'test'], 'development');
  const production = env === 'production';
  const port = num('PORT', 4000);
  const appUrl = str('APP_URL', `http://localhost:${port}`).replace(/\/$/, '');
  const clientUrl = str('CLIENT_URL', 'http://localhost:3000').replace(/\/$/, '');
  const adminUrl = str('ADMIN_URL', 'http://localhost:3001').replace(/\/$/, '');
  const extraOrigins = str('CORS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Development secrets are deterministic so restarts keep sessions; production must set them.
  const devSecret = (label: string) => `dooaa-dev-${label}-secret-change-me`;
  const bachsSecretKey = str('BACHS_SECRET_KEY');

  return {
    env,
    port,
    appUrl,
    clientUrl,
    adminUrl,
    corsOrigins: Array.from(new Set([clientUrl, adminUrl, ...extraOrigins])),
    logLevel: str('LOG_LEVEL', production ? 'info' : env === 'test' ? 'silent' : 'debug'),
    database: {
      url: str('DATABASE_URL'),
      poolMax: num('DATABASE_POOL_MAX', 10),
      statementTimeoutMs: num('DATABASE_STATEMENT_TIMEOUT_MS', 30_000),
    },
    redis: {
      url: str('REDIS_URL'),
      keyPrefix: str('REDIS_KEY_PREFIX', `dooaa:${env}:`),
    },
    jwt: {
      accessSecret: str('JWT_ACCESS_SECRET', production ? '' : devSecret('access')),
      refreshSecret: str('JWT_REFRESH_SECRET', production ? '' : devSecret('refresh')),
      staffSecret: str('JWT_STAFF_SECRET', production ? '' : devSecret('staff')),
      accessTtl: num('JWT_ACCESS_TTL_SECONDS', 15 * 60),
      staffAccessTtl: num('JWT_STAFF_ACCESS_TTL_SECONDS', 15 * 60),
      refreshTtlDays: num('JWT_REFRESH_TTL_DAYS', 30),
      staffRefreshTtlDays: num('JWT_STAFF_REFRESH_TTL_DAYS', 1),
    },
    otp: {
      ttlSeconds: num('OTP_TTL_SECONDS', 10 * 60),
      resendCooldownSeconds: num('OTP_RESEND_COOLDOWN_SECONDS', 60),
      maxAttempts: num('OTP_MAX_ATTEMPTS', 5),
      devCode: production ? undefined : str('OTP_DEV_CODE') || undefined,
      pepper: str('OTP_PEPPER', production ? '' : devSecret('otp')),
    },
    auth: {
      maxFailedSignIns: num('AUTH_MAX_FAILED_SIGNINS', 5),
      lockMinutes: num('AUTH_LOCK_MINUTES', 15),
      bcryptRounds: num('BCRYPT_ROUNDS', env === 'test' ? 4 : 12),
      cookieSameSite: oneOf<'lax' | 'strict' | 'none'>('COOKIE_SAMESITE', ['lax', 'strict', 'none'], production ? 'none' : 'lax'),
      cookieSecure: bool('COOKIE_SECURE', production),
    },
    mail: {
      from: str('SMTP_FROM', 'DOOAA <no-reply@dooaa.ng>'),
      supportInbox: str('SUPPORT_INBOX', 'support@dooaa.ng'),
      smtp: {
        host: str('SMTP_HOST'),
        port: num('SMTP_PORT', 587),
        secure: bool('SMTP_SECURE', false),
        user: str('SMTP_USER') || undefined,
        pass: str('SMTP_PASS') || undefined,
      },
    },
    sms: {
      driver: oneOf<SmsDriver>('SMS_DRIVER', ['termii', 'memory', 'log'], production ? 'termii' : 'log'),
      termii: {
        apiKey: str('TERMII_API_KEY') || undefined,
        senderId: str('TERMII_SENDER_ID', 'DOOAA'),
        baseUrl: str('TERMII_BASE_URL', 'https://api.ng.termii.com'),
      },
    },
    storage: {
      maxImageMb: num('MAX_IMAGE_MB', 10),
      maxVideoMb: num('MAX_VIDEO_MB', 50),
      maxFileMb: num('MAX_FILE_MB', 10),
      signingSecret: str('MEDIA_SIGNING_SECRET', production ? '' : devSecret('media')),
      cloudinary: {
        cloudName: str('CLOUDINARY_CLOUD_NAME'),
        apiKey: str('CLOUDINARY_API_KEY'),
        apiSecret: str('CLOUDINARY_API_SECRET'),
        folder: str('CLOUDINARY_FOLDER', 'dooaa'),
      },
    },
    payments: {
      currency: 'NGN',
      callbackUrl: str('PAYMENT_CALLBACK_URL', `${clientUrl}/checkout/callback`),
      bachs: {
        secretKey: bachsSecretKey,
        webhookSecret: str('BACHS_WEBHOOK_SECRET'),
        baseUrl: str('BACHS_BASE_URL', bachsBaseUrl(bachsSecretKey)).replace(/\/$/, ''),
      },
    },
    oauth: {
      driver: oneOf<OAuthDriver>('OAUTH_DRIVER', ['live', 'sandbox'], env === 'production' ? 'live' : 'sandbox'),
      google: {
        clientId: str('GOOGLE_CLIENT_ID') || undefined,
        clientSecret: str('GOOGLE_CLIENT_SECRET') || undefined,
      },
      facebook: {
        appId: str('FACEBOOK_APP_ID') || undefined,
        appSecret: str('FACEBOOK_APP_SECRET') || undefined,
        graphVersion: str('FACEBOOK_GRAPH_VERSION', 'v21.0'),
      },
    },
    throttle: {
      ttlMs: num('THROTTLE_TTL_MS', 60_000),
      limit: num('THROTTLE_LIMIT', 300),
      authLimit: num('AUTH_THROTTLE_LIMIT', 20),
    },
    scheduler: { enabled: bool('SCHEDULER_ENABLED', env !== 'test') },
    seed: {
      superadminEmail: str('SEED_SUPERADMIN_EMAIL', 'nelson@dooaa.com').toLowerCase(),
      superadminPassword: str('SEED_SUPERADMIN_PASSWORD') || undefined,
      superadminFirstName: str('SEED_SUPERADMIN_FIRST_NAME', 'Nelson'),
      superadminLastName: str('SEED_SUPERADMIN_LAST_NAME', 'Doe'),
    },
  };
}

/**
 * Fails fast at boot when something the app cannot run without is missing.
 * The services are required in every environment; production additionally
 * needs real secrets. The test suite replaces the services with in-memory
 * doubles, so it only needs the database.
 */
export function assertConfig(config: AppConfig): void {
  const missing: string[] = [];
  const need = (value: unknown, name: string) => {
    if (!value) missing.push(name);
  };
  need(config.database.url, 'DATABASE_URL');
  if (config.env !== 'test') {
    need(config.redis.url, 'REDIS_URL');
    need(config.mail.smtp.host, 'SMTP_HOST');
    need(config.storage.cloudinary.cloudName, 'CLOUDINARY_CLOUD_NAME');
    need(config.storage.cloudinary.apiKey, 'CLOUDINARY_API_KEY');
    need(config.storage.cloudinary.apiSecret, 'CLOUDINARY_API_SECRET');
    need(config.payments.bachs.secretKey, 'BACHS_SECRET_KEY');
    need(config.payments.bachs.webhookSecret, 'BACHS_WEBHOOK_SECRET');
  }
  if (config.env === 'production') {
    need(config.jwt.accessSecret, 'JWT_ACCESS_SECRET');
    need(config.jwt.refreshSecret, 'JWT_REFRESH_SECRET');
    need(config.jwt.staffSecret, 'JWT_STAFF_SECRET');
    need(config.otp.pepper, 'OTP_PEPPER');
    need(config.storage.signingSecret, 'MEDIA_SIGNING_SECRET');
    if (config.sms.driver === 'termii') need(config.sms.termii.apiKey, 'TERMII_API_KEY');
    if (config.payments.bachs.secretKey && !config.payments.bachs.secretKey.startsWith('sk_live_')) {
      missing.push('BACHS_SECRET_KEY (production needs a live key, sk_live_…)');
    }
    // Social sign-in is optional (a provider without credentials is just hidden), but never the fake one.
    if (config.oauth.driver === 'sandbox') missing.push('OAUTH_DRIVER (sandbox is for development only; use live)');
    for (const [name, secret] of [
      ['JWT_ACCESS_SECRET', config.jwt.accessSecret],
      ['JWT_REFRESH_SECRET', config.jwt.refreshSecret],
      ['JWT_STAFF_SECRET', config.jwt.staffSecret],
    ] as const) {
      if (secret && secret.length < 32) missing.push(`${name} (must be at least 32 characters)`);
    }
  }
  if (missing.length) {
    throw new Error(`Missing ${config.env} configuration: ${missing.join(', ')}`);
  }
}

/** Injection token for the typed config object. */
export const APP_CONFIG = Symbol('APP_CONFIG');
