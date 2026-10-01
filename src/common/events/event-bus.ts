import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process domain events, so a payment webhook can complete an order, an
 * order can fund escrow and escrow can credit an earning without those
 * modules importing each other. Handlers run in registration order and are
 * awaited; a failing handler fails the emit, which makes a provider webhook
 * answer 500 and get retried.
 */
export type DomainEvents = Record<string, unknown>;

type Handler<T> = (payload: T) => Promise<void> | void;

@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<string, Handler<unknown>[]>();

  on<T>(event: string, handler: Handler<T>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<unknown>);
    this.handlers.set(event, list);
  }

  async emit<T>(event: string, payload: T): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        await handler(payload);
      } catch (error) {
        this.logger.error(`Handler for ${event} failed: ${(error as Error).message}`);
        throw error;
      }
    }
  }

  /** Fire-and-forget: failures are logged, never thrown. For notifications and other side effects. */
  publish<T>(event: string, payload: T): void {
    void this.emit(event, payload).catch(() => undefined);
  }
}
