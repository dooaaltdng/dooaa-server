import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrdersModule } from '../orders/orders.module';
import { Dispute, DisputeSchema } from './dispute.schema';
import { AdminDisputesController, DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Dispute.name, schema: DisputeSchema }]), OrdersModule, ConversationsModule],
  controllers: [DisputesController, AdminDisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
