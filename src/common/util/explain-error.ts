/**
 * Plain-English reasons for the low-level errors the server meets most, so a
 * log line reads as a sentence first and keeps the raw error after it:
 *
 *   Could not reach Redis: the address "support.dooaa.com" does not exist. Details: ENOTFOUND getaddrinfo ENOTFOUND support.dooaa.com
 *
 * `reason` gives just the sentence; `details` just the raw part; `explain`
 * both, in that order, for one log line humans and log tooling can both read.
 */

type ErrorLike = { code?: unknown; message?: unknown; hostname?: unknown; address?: unknown; port?: unknown; responseCode?: unknown; status?: unknown };

function field(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? (error as ErrorLike) : {};
}

function where(error: ErrorLike): string {
  const host = typeof error.hostname === 'string' ? error.hostname : typeof error.address === 'string' ? error.address : '';
  const port = typeof error.port === 'number' || typeof error.port === 'string' ? `:${error.port}` : '';
  return host ? ` "${host}${port}"` : '';
}

/** The plain-English sentence for an error, without the technical tail. */
export function reason(error: unknown): string {
  const e = field(error);
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : String(error ?? 'Unknown error');
  const at = where(e);

  switch (code) {
    case 'ENOTFOUND':
      return `the address${at || ' it was given'} does not exist (check the URL or hostname in the settings)`;
    case 'EAI_AGAIN':
      return `the address${at} could not be looked up right now (the internet connection or DNS may be down)`;
    case 'ECONNREFUSED':
      return `nothing is accepting connections at${at || ' that address'} (the service may be stopped, or the port is wrong)`;
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'ECONNABORTED':
      return `it took too long to answer${at ? ` at${at}` : ''} (it may be down, overloaded, or blocked by a firewall)`;
    case 'ECONNRESET':
    case 'EPIPE':
      return 'the connection was cut off part-way through';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `the network path to${at || ' it'} is unavailable (check the internet connection)`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'its security certificate was not accepted';
    case 'EAUTH':
      return 'the username or password was rejected';
  }

  if (/WRONGPASS|NOAUTH|invalid username-password|Authentication failed|bad auth/i.test(message)) {
    return 'the username or password was rejected';
  }
  if (/timed? ?out/i.test(message)) return 'it took too long to answer';
  if (/fetch failed/i.test(message)) return 'the request could not be sent (the service may be unreachable)';
  return message;
}

/** The raw error, for the "Details:" tail. */
export function details(error: unknown): string {
  const e = field(error);
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : String(error ?? '');
  return code && !message.includes(code) ? `${code} ${message}` : message;
}

/** "<what happened>: <plain reason>. Details: <raw error>" */
export function explain(what: string, error: unknown): string {
  const plain = reason(error);
  const raw = details(error);
  return plain === raw ? `${what}: ${plain}.` : `${what}: ${plain}. Details: ${raw}`;
}
