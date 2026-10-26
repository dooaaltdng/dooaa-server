import { Module, OnModuleInit } from '@nestjs/common';
import { CouponsController } from './coupons.controller';
import { CouponsService } from './coupons.service';

@Module({
  controllers: [CouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule implements OnModuleInit {
  constructor(private readonly coupons: CouponsService) {}

  async onModuleInit(): Promise<void> {
    await this.coupons.ensureDefaults();
  }
}
