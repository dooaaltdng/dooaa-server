/** The response shape both apps already consume (`ApiResult<T>` in their api modules). */
export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = { ok: false; error: string; code: string; details?: unknown };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;
