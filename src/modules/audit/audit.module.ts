import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditEntry, AuditEntrySchema } from './audit.schema';
import { AuditService } from './audit.service';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: AuditEntry.name, schema: AuditEntrySchema }])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
