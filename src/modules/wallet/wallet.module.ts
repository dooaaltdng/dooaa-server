import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WalletService } from './wallet.service';

@Module({
  imports: [UsersModule],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
