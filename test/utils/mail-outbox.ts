import type { MailService } from '../../src/modules/mail/mail.service';
import type { MailTransport, OutgoingMail } from '../../src/modules/mail/mail.transport';

export type SentMail = OutgoingMail & { at: Date };

/** The test suite's SMTP server: every message the app sends lands here instead. */
export class MailOutbox implements MailTransport {
  readonly sent: SentMail[] = [];
  private service: MailService | null = null;

  async sendMail(message: OutgoingMail): Promise<unknown> {
    this.sent.push({ ...message, at: new Date() });
    return { messageId: `<test-${this.sent.length}@dooaa.test>` };
  }

  close(): void {}

  /** Lets `idle()` wait for the app's mail queue. */
  attach(service: MailService): void {
    this.service = service;
  }

  async idle(): Promise<void> {
    await this.service?.idle();
  }

  /** The most recent message sent to an address. */
  lastTo(address: string): SentMail | undefined {
    const needle = address.toLowerCase();
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      if (this.sent[index].to.toLowerCase() === needle) return this.sent[index];
    }
    return undefined;
  }
}
