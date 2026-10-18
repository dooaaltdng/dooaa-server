import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { BachsProvider } from './providers/bachs.provider';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider';

@Global()
@Module({
  controllers: [PaymentsController, PaymentMethodsController],
  providers: [
    PaymentsService,
    PaymentMethodsService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: ({ payments }: AppConfig): PaymentProvider => new BachsProvider(payments.bachs),
    },
  ],
  exports: [PaymentsService, PaymentMethodsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
