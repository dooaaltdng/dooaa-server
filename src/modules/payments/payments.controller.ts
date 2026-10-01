import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Errors } from '../../common/api/app-error';
import { RawResponse } from '../../common/api/raw-response.decorator';
import { CurrentUser, Public } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { AuthThrottle } from '../../common/auth/throttle';
import { ResolveAccountDto } from './dto/payments.dto';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly methods: PaymentMethodsService,
  ) {}

  /**
   * Provider webhooks. The signature over the raw body is checked before
   * anything is read; a bad signature gets a 401 and changes nothing.
   */
  @Public()
  @SkipThrottle()
  @RawResponse()
  @HttpCode(200)
  @Post('webhooks/:provider')
  async webhook(
    @Param('provider') provider: string,
    @Req() request: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
  ) {
    const accepted = await this.payments.handleWebhook(provider, request.rawBody, headers, body);
    if (!accepted) throw Errors.unauthorized('Invalid webhook signature.', 'INVALID_SIGNATURE');
    return { received: true };
  }

  @Public()
  @Get('banks')
  banks() {
    return this.methods.listBanks();
  }

  /** "Link Bank Instantly": shows the account holder's name before the account is saved. */
  @AuthThrottle()
  @HttpCode(200)
  @Post('banks/resolve')
  async resolve(@Body() body: ResolveAccountDto) {
    const resolved = await this.methods.resolveAccount(body.accountNumber, body.bankCode);
    return { accountName: resolved.accountName, bankName: resolved.bankName, bankCode: resolved.bankCode, last4: body.accountNumber.slice(-4) };
  }

  @Get(':reference')
  async get(@CurrentUser() user: AuthUser, @Param('reference') reference: string) {
    const payment = await this.payments.findByReference(reference);
    if (!payment || String(payment.buyerId) !== user.id) throw Errors.notFound('We could not find that payment.', 'PAYMENT_NOT_FOUND');
    return this.payments.view(payment);
  }

  /** Where the client lands after the provider's checkout: confirms the charge with the provider. */
  @HttpCode(200)
  @Post(':reference/verify')
  async verify(@CurrentUser() user: AuthUser, @Param('reference') reference: string) {
    return this.payments.view(await this.payments.verify(reference, user.id));
  }
}
