import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Errors } from '../../common/api/app-error';
import { RawResponse } from '../../common/api/raw-response.decorator';
import { Public } from '../../common/auth/decorators';
import { escapeHtml } from '../mail/mail.templates';
import { formatNaira } from '../../common/util/money';
import { SandboxFormDto, SandboxPayDto } from './dto/payments.dto';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider';
import { SandboxProvider } from './providers/sandbox.provider';

/**
 * The sandbox's hosted checkout page — what Paystack's page is in
 * production. It only exists while PAYMENT_PROVIDER=sandbox.
 */
@ApiExcludeController()
@Public()
@Controller('payments/sandbox')
export class SandboxController {
  constructor(@Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider) {}

  private sandbox(): SandboxProvider {
    if (!(this.provider instanceof SandboxProvider)) throw Errors.notFound();
    return this.provider;
  }

  @RawResponse()
  @Get('checkout/:reference')
  async page(@Param('reference') reference: string, @Res() response: Response) {
    const record = await this.sandbox().charge(reference);
    if (!record) throw Errors.notFound('That sandbox payment does not exist.', 'SANDBOX_NOT_FOUND');
    const email = String((record.data as { email?: string }).email ?? '');
    const done = record.status !== 'pending';
    response.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DOOAA sandbox checkout</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f4f6f8;margin:0;display:grid;place-items:center;min-height:100vh;color:#0d1828}
.card{background:#fff;border-radius:14px;padding:28px;width:min(420px,92vw);box-shadow:0 12px 30px rgb(0 0 0/.08)}
h1{font-size:20px;margin:0 0 6px}.muted{color:#5b6474;font-size:14px}.amount{font-size:32px;font-weight:700;margin:18px 0}
button{width:100%;padding:13px;border-radius:9px;border:0;font-size:15px;font-weight:600;margin-top:10px;cursor:pointer}
.pay{background:#1eb4ee;color:#fff}.alt{background:#e9f7fd;color:#0d1828}.fail{background:#fde8e8;color:#b42318}.cancel{background:transparent;color:#5b6474}
.badge{display:inline-block;background:#fff4d6;color:#8a6100;border-radius:99px;padding:3px 10px;font-size:12px;font-weight:600}</style></head>
<body><form class="card" method="post" action="">
<span class="badge">SANDBOX — no real money moves</span>
<h1 style="margin-top:12px">Pay DOOAA</h1><div class="muted">${escapeHtml(email)} · ${escapeHtml(reference)}</div>
<div class="amount">${escapeHtml(formatNaira(record.amount))}</div>
${done ? `<p class="muted">This payment is already ${escapeHtml(record.status)}.</p>` : `
<button class="pay" name="outcome" value="success" onclick="this.form.channel.value='card'">Pay with test card</button>
<button class="alt" name="outcome" value="success" onclick="this.form.channel.value='bank_transfer'">I have made the transfer</button>
<button class="fail" name="outcome" value="failed">Simulate a declined payment</button>
<button class="cancel" name="outcome" value="cancel">Cancel</button>
<input type="hidden" name="channel" value="card">`}
</form></body></html>`);
  }

  @RawResponse()
  @Post('checkout/:reference')
  async submit(@Param('reference') reference: string, @Body() body: SandboxFormDto, @Res() response: Response) {
    const sandbox = this.sandbox();
    const record = await sandbox.charge(reference);
    if (!record) throw Errors.notFound('That sandbox payment does not exist.', 'SANDBOX_NOT_FOUND');
    if (body.outcome !== 'cancel') {
      const channel = body.channel === 'bank_transfer' || body.channel === 'ussd' ? body.channel : 'card';
      await sandbox.complete(reference, body.outcome, channel);
    }
    const callback = String((record.data as { callbackUrl?: string }).callbackUrl ?? '/');
    const separator = callback.includes('?') ? '&' : '?';
    response.redirect(303, `${callback}${separator}trxref=${encodeURIComponent(reference)}&reference=${encodeURIComponent(reference)}`);
  }

  /** JSON form of the page's buttons, for API clients and tests. */
  @HttpCode(200)
  @Post(':reference/pay')
  async pay(@Param('reference') reference: string, @Body() body: SandboxPayDto) {
    const status = await this.sandbox().complete(reference, body.outcome, body.channel ?? 'card');
    return { reference, status: status.status, amount: status.amount };
  }
}
