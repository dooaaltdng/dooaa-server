import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AUTH_THROTTLE } from './common/auth/throttle';
import { EventsModule } from './common/events/events.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { APP_CONFIG, type AppConfig } from './config/configuration';
import { AuditModule } from './modules/audit/audit.module';
import { AuthCoreModule } from './modules/auth/auth-core.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { MailModule } from './modules/mail/mail.module';
import { MediaModule } from './modules/media/media.module';
import { OtpModule } from './modules/otp/otp.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProductsModule } from './modules/products/products.module';
import { WishlistModule } from './modules/wishlist/wishlist.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { CartModule } from './modules/cart/cart.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { OrdersModule } from './modules/orders/orders.module';
import { RealtimeCoreModule } from './modules/realtime/realtime-core.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { VerificationModule } from './modules/verification/verification.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { ContentModule } from './modules/content/content.module';
import { AdminUsersModule } from './modules/admin-users/admin-users.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { SupportModule } from './modules/support/support.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { AccountModule } from './modules/account/account.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SmsModule } from './modules/sms/sms.module';
import { PresenceModule } from './modules/staff/presence.module';
import { StaffModule } from './modules/staff/staff.module';
import { UsersModule } from './modules/users/users.module';

const reflector = new Reflector();

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          autoLogging: { ignore: (request) => request.url?.includes('/health') ?? false },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.refreshToken',
              '*.resetToken',
              '*.accountNumber',
            ],
            censor: '[redacted]',
          },
          transport:
            config.env === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
        },
      }),
    }),
    MongooseModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        uri: config.mongo.uri,
        dbName: config.mongo.dbName,
        autoIndex: true,
        serverSelectionTimeoutMS: 10_000,
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          { name: 'default', ttl: config.throttle.ttlMs, limit: config.throttle.limit },
          {
            name: 'auth',
            ttl: config.throttle.ttlMs,
            limit: config.throttle.authLimit,
            skipIf: (context) => !reflector.getAllAndOverride<boolean>(AUTH_THROTTLE, [context.getHandler(), context.getClass()]),
          },
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    EventsModule,
    AuditModule,
    SettingsModule,
    AuthCoreModule,
    MailModule,
    SmsModule,
    OtpModule,
    MediaModule,
    PaymentsModule,
    ProductsModule,
    WishlistModule,
    CouponsModule,
    CartModule,
    WalletModule,
    OrdersModule,
    RealtimeCoreModule,
    NotificationsModule,
    ConversationsModule,
    RealtimeModule,
    ReviewsModule,
    VerificationModule,
    DisputesModule,
    ContentModule,
    AdminUsersModule,
    AnalyticsModule,
    SupportModule,
    JobsModule,
    AccountModule,
    UsersModule,
    AuthModule,
    PresenceModule,
    StaffModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
