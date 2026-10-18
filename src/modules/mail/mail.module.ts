import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { MailService } from './mail.service';
import { MAIL_TRANSPORT, createSmtpTransport } from './mail.transport';

@Global()
@Module({
  providers: [
    MailService,
    { provide: MAIL_TRANSPORT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createSmtpTransport(config.mail.smtp) },
  ],
  exports: [MailService],
})
export class MailModule {}
