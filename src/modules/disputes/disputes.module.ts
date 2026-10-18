import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrdersModule } from '../orders/orders.module';
import { UsersModule } from '../users/users.module';
import { AdminDisputesController, DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

@Module({
  imports: [UsersModule, OrdersModule, ConversationsModule],
  controllers: [DisputesController, AdminDisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
