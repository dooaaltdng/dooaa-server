import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentUser, RequireVerifiedEmail } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { ConversationsService } from './conversations.service';
import { ConversationsQueryDto, MeetupDto, MessagesQueryDto, OfferDto, SendMessageDto, StartConversationDto } from './dto/conversations.dto';

@ApiTags('Messages')
@ApiBearerAuth('user')
@Controller()
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get('conversations')
  list(@CurrentUser() user: AuthUser, @Query() query: ConversationsQueryDto) {
    return this.conversations.list(user, query);
  }

  /** "Message seller" from a listing or a seller page. */
  @RequireVerifiedEmail()
  @Post('conversations')
  start(@CurrentUser() user: AuthUser, @Body() body: StartConversationDto) {
    return this.conversations.start(user, body);
  }

  /** The inbox badge and the dashboard's Messages tile. */
  @Get('conversations/unread-count')
  unread(@CurrentUser() user: AuthUser) {
    return this.conversations.unreadCount(user.id);
  }

  @Get('conversations/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.conversations.detail(user, id);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Query() query: MessagesQueryDto) {
    return this.conversations.messagesPage(user, id, query);
  }

  @RequireVerifiedEmail()
  @Post('conversations/:id/messages')
  send(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Body() body: SendMessageDto) {
    return this.conversations.send(user, id, body);
  }

  @HttpCode(200)
  @Post('conversations/:id/read')
  read(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.conversations.markRead(user, id);
  }

  /** "Make an Offer". */
  @RequireVerifiedEmail()
  @Post('conversations/:id/offers')
  offer(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Body() body: OfferDto) {
    return this.conversations.makeOffer(user, id, body);
  }

  @HttpCode(200)
  @Post('offers/:id/accept')
  accept(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.conversations.acceptOffer(user, id);
  }

  @HttpCode(200)
  @Post('offers/:id/decline')
  decline(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.conversations.declineOffer(user, id);
  }

  @HttpCode(200)
  @Post('offers/:id/counter')
  counter(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Body() body: OfferDto) {
    return this.conversations.counterOffer(user, id, body);
  }

  @HttpCode(200)
  @Post('offers/:id/withdraw')
  withdraw(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.conversations.withdrawOffer(user, id);
  }

  /** "Propose a Meetup". */
  @Post('conversations/:id/meetups')
  propose(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Body() body: MeetupDto) {
    return this.conversations.proposeMeetup(user, id, body);
  }

  @HttpCode(200)
  @Post('conversations/:id/meetups/:messageId/accept')
  acceptMeetup(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Param('messageId', ObjectIdPipe) messageId: string) {
    return this.conversations.respondToMeetup(user, id, messageId, 'accepted');
  }

  @HttpCode(200)
  @Post('conversations/:id/meetups/:messageId/decline')
  declineMeetup(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Param('messageId', ObjectIdPipe) messageId: string) {
    return this.conversations.respondToMeetup(user, id, messageId, 'declined');
  }
}
