import { Global, Module } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider';
import { PaystackProvider } from './providers/paystack.provider';
import { SandboxProvider } from './providers/sandbox.provider';
import { SandboxController } from './sandbox.controller';
import { Payment, PaymentSchema } from './schemas/payment.schema';
import { PayoutAccount, PayoutAccountSchema } from './schemas/payout-account.schema';
import { SandboxRecord, SandboxRecordSchema } from './schemas/sandbox-record.schema';
import { SavedCard, SavedCardSchema } from './schemas/saved-card.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: SavedCard.name, schema: SavedCardSchema },
      { name: PayoutAccount.name, schema: PayoutAccountSchema },
      { name: SandboxRecord.name, schema: SandboxRecordSchema },
    ]),
  ],
  controllers: [PaymentsController, SandboxController, PaymentMethodsController],
  providers: [
    PaymentsService,
    PaymentMethodsService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [APP_CONFIG, getModelToken(SandboxRecord.name)],
      useFactory: (config: AppConfig, records: Model<SandboxRecord>): PaymentProvider =>
        config.payments.provider === 'paystack'
          ? new PaystackProvider(config.payments.paystack.secretKey!, config.payments.paystack.baseUrl)
          : new SandboxProvider(records, {
              appUrl: config.appUrl,
              secret: config.payments.sandboxSecret,
              delayMs: config.payments.sandboxDelayMs,
            }),
    },
  ],
  exports: [PaymentsService, PaymentMethodsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
