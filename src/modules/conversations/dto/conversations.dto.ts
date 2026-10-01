import { Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsNumber, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { USER_MESSAGE_KINDS, type UserMessageKind } from '../../../common/domain';
import { PageQueryDto } from '../../../common/util/pagination';
import { Trim } from '../../../common/util/transforms';

export class StartConversationDto {
  @IsOptional() @IsMongoId() productId?: string;
  @IsOptional() @IsMongoId() sellerId?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(2000) body?: string;
}

export class ConversationsQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['all', 'unread']) filter?: 'all' | 'unread';
  @IsOptional() @Trim() @IsString() @MaxLength(80) q?: string;
}

export class MessagesQueryDto {
  /** Message id to page backwards from. */
  @IsOptional() @IsMongoId() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class SendMessageDto {
  @IsOptional() @IsIn(USER_MESSAGE_KINDS) kind?: UserMessageKind;
  @IsOptional() @Trim() @IsString() @MaxLength(2000) body?: string;
  /** An image, video or file uploaded with purpose "message". */
  @IsOptional() @IsUrl({ require_tld: false, require_protocol: true }) mediaUrl?: string;
}

export class OfferDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter an amount.' }) @Min(1, { message: 'Enter an amount.' }) @Max(10_000_000_000) amount: number;
  @IsOptional() @Trim() @IsString() @MaxLength(500) note?: string;
}

export class MeetupDto {
  @Trim() @IsString() @MinLength(3, { message: 'Where should you meet?' }) @MaxLength(300) place: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Pick a day.' }) date: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Pick a start time.' }) from: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Pick an end time.' }) to: string;
  @IsOptional() @IsUrl({ require_tld: false, require_protocol: true }) photo?: string;
}
