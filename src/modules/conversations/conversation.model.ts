import type { MessageKind } from '../../common/domain';
import { conversations, messages, offers, type ConversationSubject } from '../../database/schema';

export type ConversationRow = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Offer = typeof offers.$inferSelect;

export type LastMessage = { preview: string; kind: MessageKind | null; at: Date | null; senderId: string | null };

/** A buyer and a seller talking, usually about one listing and often one order. */
export type Conversation = {
  id: string;
  buyerId: string;
  sellerId: string;
  productId: string | null;
  /** The listing the thread is about, pinned at the top of the chat. */
  subject: ConversationSubject | null;
  /** The escrow order this thread follows, once the buyer pays. */
  orderId: string | null;
  disputeId: string | null;
  lastMessage: LastMessage;
  buyerUnread: number;
  sellerUnread: number;
  buyerReadAt: Date | null;
  sellerReadAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    buyerId: row.buyerId,
    sellerId: row.sellerId,
    productId: row.productId,
    subject: row.subject,
    orderId: row.orderId,
    disputeId: row.disputeId,
    lastMessage: { preview: row.lastMessagePreview, kind: row.lastMessageKind, at: row.lastMessageAt, senderId: row.lastMessageSenderId },
    buyerUnread: row.buyerUnread,
    sellerUnread: row.sellerUnread,
    buyerReadAt: row.buyerReadAt,
    sellerReadAt: row.sellerReadAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
