import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../users/users.module';
import { Earning, EarningSchema, Payout, PayoutSchema, Wallet, WalletSchema } from './wallet.schema';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wallet.name, schema: WalletSchema },
      { name: Earning.name, schema: EarningSchema },
      { name: Payout.name, schema: PayoutSchema },
    ]),
    UsersModule,
  ],
  providers: [WalletService],
  exports: [WalletService, MongooseModule],
})
export class WalletModule {}
