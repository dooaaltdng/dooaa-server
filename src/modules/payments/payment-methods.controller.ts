import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Errors } from '../../common/api/app-error';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
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
      throw Errors.badRequest('Cards are saved securely when you pay with them at checkout — DOOAA never handles card numbers.', 'CARD_ENTRY_NOT_SUPPORTED');
    }
    if (!body.bankCode || !body.accountNumber) {
      throw Errors.badRequest('Choose a bank and enter the 10-digit account number.', 'VALIDATION_FAILED');
    }
    return this.methods.addPayoutAccount(user.id, { bankCode: body.bankCode, accountNumber: body.accountNumber, primary: body.primary });
  }

  @HttpCode(200)
  @Post(':id/primary')
  primary(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.methods.setPrimary(user.id, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.methods.remove(user.id, id);
  }
}
