import { Module } from '@nestjs/common';
import { EmailToolController } from './email-tool.controller';
import { EmailToolService } from './email-tool.service';

@Module({
  controllers: [EmailToolController],
  providers: [EmailToolService],
})
export class EmailToolModule {}
