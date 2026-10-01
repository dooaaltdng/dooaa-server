import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Message, MessageSchema } from '../conversations/schemas/message.schema';
import { Dispute, DisputeSchema } from '../disputes/dispute.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Dispute.name, schema: DisputeSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
    UsersModule,
    ProductsModule,
    VerificationModule,
  ],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class AdminUsersModule {}
