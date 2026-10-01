/** Test-wide environment. Values here keep every side effect in memory. */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
process.env.JWT_STAFF_SECRET = 'test-staff-secret-0123456789abcdef';
process.env.MAIL_TRANSPORT = 'memory';
process.env.SMS_DRIVER = 'memory';
process.env.STORAGE_DRIVER = 'memory';
process.env.PAYMENT_PROVIDER = 'sandbox';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.SCHEDULER_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '10000';
process.env.AUTH_THROTTLE_LIMIT = '10000';
process.env.APP_URL = 'http://localhost:4000';
process.env.CLIENT_URL = 'http://localhost:3000';
process.env.ADMIN_URL = 'http://localhost:3001';
