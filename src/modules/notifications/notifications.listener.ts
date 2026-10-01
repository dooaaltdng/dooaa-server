import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../common/events/event-bus';
import { longDate } from '../../common/util/dates';
import { formatNaira } from '../../common/util/money';
import type { Lean } from '../../common/util/mongo';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { CONVERSATION_EVENTS, type ConversationMessageEvent, type ConversationOfferEvent } from '../conversations/conversations.service';
import { ORDER_EVENTS, type OrderUpdated } from '../orders/orders.service';
import type { Order } from '../orders/schemas/order.schema';
import { PRODUCT_EVENTS, type ProductFlagged, type ProductStatusChanged } from '../products/products.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SettingsService } from '../settings/settings.service';
import { WALLET_EVENTS, type PayoutUpdated } from '../wallet/wallet.service';
import { WISHLIST_EVENTS, type RestockAlert } from '../wishlist/wishlist.service';
import { NotificationsService } from './notifications.service';

const MESSAGE_EMAIL_COOLDOWN_MS = 30 * 60_000;

/**
 * Turns what happens on the marketplace into the bell, live socket pushes,
 * emails and texts. Nothing here can fail the action that triggered it.
 */
@Injectable()
export class NotificationsListener implements OnModuleInit {
  private readonly logger = new Logger(NotificationsListener.name);
  /** Last message email per conversation+recipient, so a busy chat does not flood an inbox. */
  private readonly lastMessageEmail = new Map<string, number>();

  constructor(
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeService,
    private readonly events: EventBus,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.events.on<OrderUpdated>(ORDER_EVENTS.updated, (event) => this.safe(() => this.onOrder(event)));
    this.events.on<ConversationMessageEvent>(CONVERSATION_EVENTS.message, (event) => this.safe(() => this.onMessage(event)));
    this.events.on<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, (event) => this.safe(() => this.onOffer(event)));
    this.events.on<ProductFlagged>(PRODUCT_EVENTS.flagged, (event) => this.safe(() => this.onFlagged(event)));
    this.events.on<ProductStatusChanged>(PRODUCT_EVENTS.statusChanged, (event) => this.safe(() => this.onListingStatus(event)));
    this.events.on<RestockAlert>(WISHLIST_EVENTS.restockAlert, (event) => this.safe(() => this.onRestock(event)));
    this.events.on<PayoutUpdated>(WALLET_EVENTS.payoutUpdated, (event) => this.safe(() => this.onPayout(event)));
  }

  private async safe(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.warn(`Notification side effect failed: ${(error as Error).message}`);
    }
  }

  private clientLink(path: string): string {
    return `${this.config.clientUrl}${path}`;
  }

  private itemsLabel(order: Lean<Order>): string {
    const first = order.items[0]?.title ?? 'your item';
    return order.items.length > 1 ? `${first} and ${order.items.length - 1} more` : first;
  }

  private async onOrder({ order, event, note }: OrderUpdated): Promise<void> {
    const buyer = String(order.buyerId);
    const seller = String(order.sellerId);
    const number = `#${order.reference}`;
    const buyerLink = `/orders/${order.reference}`;
    const sellerLink = `/seller/orders/${order.reference}`;
    const items = this.itemsLabel(order);

    switch (event) {
      case 'paid': {
        await this.notifications.notifyUser(seller, {
          type: 'order.new',
          title: `New order ${number}`,
          body: `${items} — ${formatNaira(order.sellerEarning)} is held in escrow for you. Confirm it within 24 hours.`,
          tone: 'green',
          link: sellerLink,
          data: { orderId: order.reference },
          email: {
            subject: `New order ${number} on DOOAA`,
            heading: 'You have a new order',
            paragraphs: [
              `${items} was just bought from your store. The buyer's payment is held safely in escrow.`,
              order.shipBy ? `Confirm the order and ship it by ${longDate(order.shipBy)}.` : 'Confirm the order and ship it soon.',
            ],
            cta: { label: 'View order', url: this.clientLink(sellerLink) },
          },
          sms: `DOOAA: New order ${number} for ${items}. Ship by ${order.shipBy ? longDate(order.shipBy) : 'soon'}.`,
        });
        await this.notifications.notifyUser(buyer, {
          type: 'order.placed',
          title: `Order ${number} placed`,
          body: `Your payment of ${formatNaira(order.total)} is held in escrow until the item is delivered.`,
          tone: 'green',
          link: buyerLink,
          data: { orderId: order.reference },
          email: {
            subject: `Your DOOAA order ${number}`,
            heading: 'Thanks for your order',
            paragraphs: [
              `We received your order for ${items}.`,
              `${formatNaira(order.total)} is held safely in escrow. The seller is paid only after you confirm the item arrived as described.`,
            ],
            cta: { label: 'Track your order', url: this.clientLink(buyerLink) },
          },
        });
        const alerts = await this.settings.section('notifications');
        if (alerts.highValueTransaction && order.total >= alerts.highValueThreshold) {
          await this.notifications.notifyStaff({
            type: 'escrow.high-value',
            title: 'High-value transaction funded',
            body: `${formatNaira(order.total)} for ${items} (${number}).`,
            tone: 'blue',
            link: `/payments?search=${encodeURIComponent(order.escrow?.reference ?? order.reference)}`,
          });
        }
        return;
      }
      case 'confirmed':
        await this.notifications.notifyUser(buyer, {
          type: 'order.confirmed',
          title: `Order ${number} confirmed`,
          body: 'The seller is preparing your item for dispatch.',
          link: buyerLink,
        });
        return;
      case 'shipped':
        await this.notifications.notifyUser(buyer, {
          type: 'order.shipped',
          title: 'Your order is on its way',
          body: `${items} was handed to ${order.shipment?.carrier ?? 'the courier'}. Tracking ${order.shipment?.trackingNumber ?? ''}.`.trim(),
          tone: 'green',
          link: buyerLink,
          email: {
            subject: `Order ${number} has shipped`,
            heading: 'Your order is on its way',
            paragraphs: [
              `${items} was handed to ${order.shipment?.carrier ?? 'the courier'}.`,
              order.shipment?.trackingNumber ? `Tracking number: ${order.shipment.trackingNumber}` : 'The seller will share tracking details in your conversation.',
              'When it arrives, check it before confirming — confirming releases payment to the seller.',
            ],
            cta: { label: 'Track your order', url: this.clientLink(buyerLink) },
          },
          sms: `DOOAA: Order ${number} shipped with ${order.shipment?.carrier ?? 'courier'}. Tracking ${order.shipment?.trackingNumber ?? 'in app'}.`,
        });
        return;
      case 'received':
        await this.notifications.notifyUser(seller, {
          type: 'order.received',
          title: `Buyer received order ${number}`,
          body: `The inspection period has started${order.escrow?.inspectionEndsAt ? ` and ends ${longDate(order.escrow.inspectionEndsAt)}` : ''}.`,
          link: sellerLink,
        });
        return;
      case 'delivered':
        await this.notifications.notifyUser(buyer, {
          type: 'order.delivered',
          title: `Order ${number} marked as delivered`,
          body: `Check the item. Payment releases to the seller when you confirm${order.escrow?.inspectionEndsAt ? ` or on ${longDate(order.escrow.inspectionEndsAt)}` : ''}. Something wrong? Open a dispute before then.`,
          tone: 'blue',
          link: buyerLink,
          email: {
            subject: `Order ${number} was delivered`,
            heading: 'Your order was delivered',
            paragraphs: [
              `The seller marked ${items} as delivered.`,
              `Inspect it and confirm when you are happy. If something is wrong, open a dispute${order.escrow?.inspectionEndsAt ? ` before ${longDate(order.escrow.inspectionEndsAt)}` : ''} and payment stays on hold.`,
            ],
            cta: { label: 'Review your order', url: this.clientLink(buyerLink) },
          },
        });
        return;
      case 'released':
        await this.notifications.notifyUser(seller, {
          type: 'escrow.released',
          title: 'Payment released',
          body: `${formatNaira(order.sellerEarning)} from order ${number} is now in your available balance.`,
          tone: 'green',
          link: '/seller/earnings',
          email: {
            subject: `Payment released for order ${number}`,
            heading: 'You have been paid',
            paragraphs: [`${formatNaira(order.sellerEarning)} from order ${number} is now available to withdraw.`],
            cta: { label: 'Withdraw', url: this.clientLink('/seller/earnings') },
          },
        });
        await this.notifications.notifyUser(buyer, {
          type: 'order.completed',
          title: `Order ${number} is complete`,
          body: 'How was it? Rate your experience with the seller.',
          category: 'feedback',
          link: buyerLink,
        });
        return;
      case 'cancelled': {
        const byBuyer = order.cancelledBy === 'buyer';
        await this.notifications.notifyUser(byBuyer ? seller : buyer, {
          type: 'order.cancelled',
          title: `Order ${number} was cancelled`,
          body: note ?? 'The order was cancelled.',
          tone: 'red',
          link: byBuyer ? sellerLink : buyerLink,
        });
        await this.notifications.notifyUser(buyer, {
          type: 'refund.requested',
          title: 'Refund on its way',
          body: `${formatNaira(order.total)} is being returned to your original payment method.`,
          link: buyerLink,
          email: {
            subject: `Refund for order ${number}`,
            heading: 'Your refund is on its way',
            paragraphs: [
              `Order ${number} was cancelled${note ? `: ${note}` : '.'}`,
              `We have asked our payment provider to return ${formatNaira(order.total)} to your original payment method. Banks usually take 3–5 business days.`,
            ],
          },
        });
        return;
      }
      case 'cancellation-requested':
        await this.notifications.notifyUser(seller, {
          type: 'order.cancellation-requested',
          title: `Cancellation requested on ${number}`,
          body: note ?? 'The buyer asked to cancel this order.',
          tone: 'red',
          link: sellerLink,
        });
        return;
      case 'refund-processed':
        await this.notifications.notifyUser(buyer, {
          type: 'refund.processed',
          title: 'Refund completed',
          body: `${formatNaira(order.refund?.amount ?? order.total)} for order ${number} is back on your payment method.`,
          tone: 'green',
          link: buyerLink,
        });
        return;
      case 'refund-failed':
        await this.notifications.notifyStaff({
          type: 'refund.failed',
          title: 'A refund failed at the provider',
          body: `Order ${number} (${formatNaira(order.total)}) needs a manual refund.`,
          tone: 'red',
          link: `/payments?search=${encodeURIComponent(order.escrow?.reference ?? order.reference)}`,
        });
        return;
      case 'reversed':
        await this.notifications.notifyUser(seller, {
          type: 'escrow.reversed',
          title: `Payment for ${number} is back on hold`,
          body: 'DOOAA reopened this order for review. Support will be in touch.',
          tone: 'red',
          link: sellerLink,
        });
        return;
      default:
        return;
    }
  }

  private async onMessage({ conversation, message, recipientIds, senderName }: ConversationMessageEvent): Promise<void> {
    if (message.kind === 'system') return;
    for (const recipient of recipientIds) {
      const role = String(conversation.buyerId) === recipient ? 'buyer' : 'seller';
      const online = this.realtime.isOnline(recipient);
      const key = `${String(conversation._id)}:${recipient}`;
      const last = this.lastMessageEmail.get(key) ?? 0;
      const emailNow = !online && Date.now() - last > MESSAGE_EMAIL_COOLDOWN_MS;
      if (emailNow) this.lastMessageEmail.set(key, Date.now());
      const name = message.senderRole === 'staff' ? 'DOOAA Support' : senderName;
      await this.notifications.notifyUser(recipient, {
        type: 'message.new',
        title: `New message from ${name}`,
        body: message.body ? message.body.slice(0, 140) : conversation.lastMessage?.preview || 'Sent an attachment',
        category: 'messages',
        link: `/messages?c=${String(conversation._id)}`,
        data: { conversationId: String(conversation._id), role },
        email: emailNow
          ? {
              subject: `New message from ${name} on DOOAA`,
              heading: `${name} sent you a message`,
              paragraphs: [message.body ? `“${message.body.slice(0, 300)}”` : 'They sent you an attachment.', 'Reply on DOOAA so the conversation stays protected.'],
              cta: { label: 'Reply', url: this.clientLink(`/messages?c=${String(conversation._id)}`) },
            }
          : undefined,
      });
    }
    if (this.lastMessageEmail.size > 10_000) this.lastMessageEmail.clear();
  }

  private async onOffer({ conversation, offer, action, recipientId }: ConversationOfferEvent): Promise<void> {
    const title = conversation.subject?.title ?? 'your listing';
    const link = `/messages?c=${String(conversation._id)}`;
    const copy: Record<ConversationOfferEvent['action'], { title: string; body: string; tone: 'blue' | 'green' | 'red' }> = {
      made: { title: `New offer: ${formatNaira(offer.amount)}`, body: `On ${title} (listed at ${formatNaira(offer.listed)}).`, tone: 'blue' },
      accepted: { title: 'Offer accepted', body: `${formatNaira(offer.agreedAmount ?? offer.amount)} was agreed for ${title}. Pay through escrow to secure it.`, tone: 'green' },
      countered: { title: `Counter offer: ${formatNaira(offer.counter?.amount ?? 0)}`, body: `The seller countered your offer on ${title}.`, tone: 'blue' },
      declined: { title: 'Offer declined', body: `Your offer on ${title} was declined.`, tone: 'red' },
      withdrawn: { title: 'Offer withdrawn', body: `The buyer withdrew their offer on ${title}.`, tone: 'red' },
    };
    await this.notifications.notifyUser(recipientId, { type: `offer.${action}`, ...copy[action], category: 'messages', link, data: { offerId: String(offer._id) } });
  }

  private async onFlagged(event: ProductFlagged): Promise<void> {
    const alerts = await this.settings.section('notifications');
    if (!alerts.suspiciousListing) return;
    await this.notifications.notifyStaff({
      type: 'listing.flagged',
      title: 'Listing flagged as suspicious',
      body: `“${event.title}” at ${formatNaira(event.price)} (${event.reasons.join(', ') || 'review'}).`,
      tone: 'red',
      link: `/listings?search=${encodeURIComponent(event.title)}`,
    });
  }

  private async onListingStatus(event: ProductStatusChanged): Promise<void> {
    if (event.by === 'seller') return;
    const link = `/seller/products/${event.productId}`;
    const copy: Partial<Record<string, { title: string; body: string; tone: 'blue' | 'green' | 'red' }>> = {
      active: { title: 'Your listing is live', body: `“${event.title}” is now visible to buyers.`, tone: 'green' },
      rejected: { title: 'Your listing was not approved', body: event.note ? `“${event.title}”: ${event.note}` : `“${event.title}” needs changes before it can go live.`, tone: 'red' },
      suspicious: { title: 'Your listing is under review', body: `“${event.title}” was flagged for a closer look.`, tone: 'red' },
      inactive: { title: 'Your listing was deactivated', body: event.note ? `“${event.title}”: ${event.note}` : `“${event.title}” is no longer visible to buyers.`, tone: 'red' },
      pending: { title: 'Your listing is in review', body: `“${event.title}” will go live once it is approved.`, tone: 'blue' },
    };
    const entry = copy[event.to];
    if (!entry) return;
    await this.notifications.notifyUser(event.sellerId, { type: `listing.${event.to}`, ...entry, link });
  }

  private async onRestock(event: RestockAlert): Promise<void> {
    await this.notifications.notifyUsers(event.userIds, {
      type: 'product.restocked',
      title: 'Back in stock',
      body: `“${event.title}” is available again.`,
      tone: 'green',
      category: 'deals',
      link: `/products/${event.productId}`,
      email: {
        subject: `Back in stock: ${event.title}`,
        heading: 'It is back',
        paragraphs: [`“${event.title}” is available again on DOOAA.`],
        cta: { label: 'View item', url: this.clientLink(`/products/${event.productId}`) },
      },
    });
  }

  private async onPayout({ payout }: PayoutUpdated): Promise<void> {
    const destination = `${payout.destination.bankName} ****${payout.destination.last4}`;
    if (payout.status === 'completed') {
      await this.notifications.notifyUser(payout.sellerId, {
        type: 'payout.completed',
        title: 'Payout completed',
        body: `${formatNaira(payout.amount)} was sent to ${destination}.`,
        tone: 'green',
        link: '/seller/earnings',
        email: {
          subject: 'Your DOOAA payout is complete',
          heading: 'Money on its way to your bank',
          paragraphs: [`${formatNaira(payout.amount)} was transferred to ${destination}.`],
        },
      });
    } else if (payout.status === 'failed') {
      await this.notifications.notifyUser(payout.sellerId, {
        type: 'payout.failed',
        title: 'Payout failed',
        body: `${formatNaira(payout.amount)} to ${destination} did not go through and is back in your balance. ${payout.failureReason ?? ''}`.trim(),
        tone: 'red',
        link: '/seller/earnings',
        email: {
          subject: 'Your DOOAA payout did not go through',
          heading: 'Payout failed',
          paragraphs: [
            `${formatNaira(payout.amount)} to ${destination} could not be completed${payout.failureReason ? `: ${payout.failureReason}` : '.'}`,
            'The money is back in your available balance. Check your bank details and try again.',
          ],
        },
      });
    }
  }
}
