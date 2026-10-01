import request, { type Response } from 'supertest';
import type { TestApp } from './app';

export const API = '/api/v1';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Thin supertest wrapper: prefixes the API path, attaches a bearer token,
 * and returns the parsed envelope alongside the raw response.
 */
export class Http {
  constructor(private readonly t: TestApp) {}

  private send(method: Method, path: string, token?: string, body?: unknown, headers?: Record<string, string>) {
    let call = request(this.t.server)[method](`${API}${path}`);
    if (token) call = call.set('Authorization', `Bearer ${token}`);
    for (const [key, value] of Object.entries(headers ?? {})) call = call.set(key, value);
    if (body !== undefined) call = call.send(body as object);
    return call;
  }

  get(path: string, token?: string, headers?: Record<string, string>) {
    return this.send('get', path, token, undefined, headers);
  }
  post(path: string, body?: unknown, token?: string, headers?: Record<string, string>) {
    return this.send('post', path, token, body ?? {}, headers);
  }
  put(path: string, body?: unknown, token?: string) {
    return this.send('put', path, token, body ?? {});
  }
  patch(path: string, body?: unknown, token?: string) {
    return this.send('patch', path, token, body ?? {});
  }
  delete(path: string, token?: string, body?: unknown) {
    return this.send('delete', path, token, body);
  }
}

/** Asserts a success envelope and returns its data. */
export function data<T = any>(response: Response, status: number | number[] = [200, 201]): T {
  const statuses = Array.isArray(status) ? status : [status];
  if (!statuses.includes(response.status) || response.body?.ok !== true) {
    throw new Error(`Expected ok ${statuses.join('/')} but got ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.data as T;
}

/** Asserts a failure envelope with the given status (and code) and returns it. */
export function failure(response: Response, status: number, code?: string): { ok: false; error: string; code: string; details?: any } {
  if (response.status !== status || response.body?.ok !== false) {
    throw new Error(`Expected failure ${status} but got ${response.status}: ${JSON.stringify(response.body)}`);
  }
  if (code && response.body.code !== code) {
    throw new Error(`Expected code ${code} but got ${response.body.code}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}
