import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminSupportController, SupportController } from './support.controller';
import { SupportTicket, SupportTicketSchema } from './support.schema';
import { SupportService } from './support.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: SupportTicket.name, schema: SupportTicketSchema }])],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}
