/**
 * Same-origin API calls. The session is an HttpOnly cookie the browser sends
 * by itself (`credentials: 'same-origin'`): there is no token in page JS and
 * no `Authorization` header to attach. Mutating requests carry the browser's
 * own `Origin` header, and the server's CSRF check refuses any cookie-bearing
 * mutating request whose Origin (or, without one, Referer) is not one of the
 * app's origins, whatever its content type (see AGENTS.md "CSRF"). Nothing
 * extra is needed here.
 */

/**
 * What the server asked for when it refused a request for the session's
 * assurance level:
 * - `verify`: 403 `mfa_required` with `mfa_enrolled: true`. Verify a code
 *   from the authenticator on this session (step-up), then retry.
 * - `enroll`: 403 `mfa_required` with `mfa_enrolled: false`. Two-factor is
 *   required and not set up yet.
 * - `reauth`: 403 `reauth_required`. The session is too old for this step;
 *   sign in again.
 */
export type StepUpReason = 'verify' | 'enroll' | 'reauth';

/** Resolves true when the session now passes (retry the request once). */
export type StepUpHandler = (reason: StepUpReason) => Promise<boolean>;

let stepUpHandler: StepUpHandler | null = null;

/**
 * Register the app's step-up prompt (the AuthProvider does this). Returns an
 * unregister function. Without a handler, refusals pass through untouched.
 */
export function setStepUpHandler(handler: StepUpHandler): () => void {
  stepUpHandler = handler;
  return () => {
    if (stepUpHandler === handler) stepUpHandler = null;
  };
}

/** Reads the step-up reason off a refused response without consuming its body. */
export async function stepUpReason(response: Response): Promise<StepUpReason | null> {
  if (response.status !== 403) return null;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: string; mfa_enrolled?: boolean } | null;
  if (body?.error === 'mfa_required') return body.mfa_enrolled ? 'verify' : 'enroll';
  if (body?.error === 'reauth_required') return 'reauth';
  return null;
}

/**
 * Extract error message from API response.
 * Handles both JSON error responses and non-JSON responses.
 */
export async function extractApiError(
  response: Response,
  fallback = 'Request failed'
): Promise<string> {
  try {
    const data = await response.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Error thrown by `apiJson` for non-2xx responses. Carries the HTTP status so
 * callers can branch (e.g. 401 → sign-in prompt, 403 → plan gate) without
 * string-matching the message.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Same-origin fetch with the session cookie. Returns the raw Response; prefer
 * `apiJson` unless you need the Response itself (blobs, manual status
 * handling). A string body is sent as JSON.
 *
 * When the server refuses for the session's assurance level (403
 * `mfa_required` / `reauth_required`), the registered step-up handler runs
 * (prompt for a code, or send the user to enroll or sign in again); when it
 * reports success, the request is retried once.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // Any HeadersInit (object, array or Headers instance) survives; a spread
  // would drop a Headers instance's entries. Caller's Content-Type wins.
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const send = () => fetch(path, { ...init, headers, credentials: 'same-origin' });
  const response = await send();
  if (!stepUpHandler) return response;
  const reason = await stepUpReason(response);
  if (!reason) return response;
  return (await stepUpHandler(reason)) ? send() : response;
}

/**
 * The standard JSON request for every TanStack Query `queryFn`/`mutationFn`:
 * the session cookie, step-up on `mfa_required`, JSON body handling, and
 * uniform error extraction. Non-2xx responses throw `ApiError` with the
 * server's `error` field (or `fallback`).
 *
 * Replaces the per-page `fetch` + `if (!res.ok) throw` boilerplate. Do not
 * hand-roll that pattern in pages. Reads use it inside `useQuery`, writes
 * inside `useMutation`; see AGENTS.md "Data Fetching".
 *
 * @param path API path (e.g. `/api/v1/admin/users?page=2`)
 * @param init fetch init; `body` objects are JSON.stringified automatically
 * @param fallback error message when the response carries no `error` field
 */
export async function apiJson<T>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: BodyInit | object | null } = {},
  fallback = 'Request failed'
): Promise<T> {
  const body =
    init.body != null &&
    typeof init.body === 'object' &&
    !(init.body instanceof FormData) &&
    !(init.body instanceof Blob)
      ? JSON.stringify(init.body)
      : (init.body as BodyInit | null | undefined);
  const response = await apiFetch(path, { ...init, body });
  if (!response.ok) {
    throw new ApiError(await extractApiError(response, fallback), response.status);
  }
  // 204/205 carry no body — normalize to undefined for callers typed as void.
  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
