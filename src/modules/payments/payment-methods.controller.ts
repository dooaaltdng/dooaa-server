import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Errors } from '../../common/api/app-error';
import { UuidPipe } from '../../common/api/uuid.pipe';
import { CurrentUser } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { AuthThrottle } from '../../common/auth/throttle';
import { AddPaymentAccountDto } from './dto/payments.dto';
import { PaymentMethodsService } from './payment-methods.service';

@ApiTags('Account · Payment methods')
@Controller('me/payment-accounts')
export class PaymentMethodsController {
  constructor(private readonly methods: PaymentMethodsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.methods.accountsFor(user.id, `${user.firstName} ${user.lastName}`);
  }

  @AuthThrottle()
  @Post()
  add(@CurrentUser() user: AuthUser, @Body() body: AddPaymentAccountDto) {
    if (body.type === 'card') {
      throw Errors.badRequest('DOOAA does not store cards. You enter your card on Bachs’ secure page each time you pay.', 'CARD_ENTRY_NOT_SUPPORTED');
    }
    if (!body.bankCode || !body.accountNumber) {
      throw Errors.badRequest('Choose a bank and enter the 10-digit account number.', 'VALIDATION_FAILED');
    }
    return this.methods.addPayoutAccount(user.id, { bankCode: body.bankCode, accountNumber: body.accountNumber, primary: body.primary });
  }

  @HttpCode(200)
  @Post(':id/primary')
  primary(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.methods.setPrimary(user.id, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.methods.remove(user.id, id);
  }
}
