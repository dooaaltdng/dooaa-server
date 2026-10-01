/** Server → client events on the `/realtime` namespace. */
export const SERVER_EVENTS = {
  messageNew: 'message:new',
  messageUpdated: 'message:updated',
  conversationUpdated: 'conversation:updated',
  conversationRead: 'conversation:read',
  typing: 'typing',
  notification: 'notification:new',
  orderUpdated: 'order:updated',
  presence: 'presence',
  disputeMessage: 'dispute:message',
  disputeUpdated: 'dispute:updated',
} as const;

/** Client → server messages (all acknowledged with `{ ok, data | error, code }`). */
export const CLIENT_EVENTS = {
  join: 'conversation:join',
  leave: 'conversation:leave',
  typing: 'typing',
  send: 'message:send',
  read: 'conversation:read',
  presence: 'presence:query',
  disputeJoin: 'dispute:join',
} as const;
