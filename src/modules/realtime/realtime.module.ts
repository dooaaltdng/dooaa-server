import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { StaffModule } from '../staff/staff.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [ConversationsModule, StaffModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
