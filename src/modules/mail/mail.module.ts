import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { MailService } from './mail.service';
import { MAIL_TRANSPORT, createResendTransport, createSmtpTransport } from './mail.transport';

@Global()
@Module({
  providers: [
    MailService,
    { provide: MAIL_TRANSPORT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => (config.mail.resendApiKey ? createResendTransport(config.mail.resendApiKey) : createSmtpTransport(config.mail.smtp)) },
  ],
  exports: [MailService],
})
export class MailModule {}
