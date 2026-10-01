import { Injectable, Logger } from '@nestjs/common';
import { normalizePhone } from '../../common/util/text';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';

export type SmsChannel = 'sms' | 'whatsapp';
export type SentSms = { to: string; body: string; channel: SmsChannel; at: Date };

/**
 * SMS and WhatsApp delivery for one-time codes. Termii is the production
 * driver (Nigerian routes, DND-safe "dnd" channel for OTPs, WhatsApp);
 * `memory` keeps an outbox for tests and `log` prints for development.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  readonly outbox: SentSms[] = [];

  constructor(@InjectConfig() private readonly config: AppConfig) {}

  /** Returns false when the provider refused the message; callers decide whether that matters. */
  async send(to: string, body: string, channel: SmsChannel = 'sms'): Promise<boolean> {
    const message: SentSms = { to, body, channel, at: new Date() };
    if (this.config.sms.driver !== 'termii') {
      this.outbox.push(message);
      if (this.outbox.length > 500) this.outbox.shift();
      if (this.config.sms.driver === 'log') this.logger.log(`📱 ${channel} ${to}: ${body}`);
      return true;
    }
    try {
      const response = await fetch(`${this.config.sms.termii.baseUrl}/api/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.config.sms.termii.apiKey,
          to: to.replace(/\D/g, ''),
          from: this.config.sms.termii.senderId,
          sms: body,
          type: 'plain',
          channel: channel === 'whatsapp' ? 'whatsapp' : 'dnd',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.logger.warn(`Termii refused a ${channel} to ${to}: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Termii ${channel} to ${to} failed: ${(error as Error).message}`);
      return false;
    }
  }

  lastTo(phone: string): SentSms | undefined {
    const wanted = normalizePhone(phone);
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      if (normalizePhone(this.outbox[index].to) === wanted) return this.outbox[index];
    }
    return undefined;
  }
}
