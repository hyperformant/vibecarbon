import { supabase } from './supabase';

/**
 * Get authorization headers for API requests.
 * Retrieves the current session and returns headers with the access token.
 */
export async function getAuthHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (session) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  return headers;
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
 * Authenticated fetch: merges the Supabase session auth headers with any
 * caller-provided ones and returns the raw Response. Prefer `apiJson` unless
 * you need the Response itself (blobs, manual status handling).
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(await getAuthHeaders()), ...(init.headers ?? {}) };
  return fetch(path, { ...init, headers });
}

/**
 * The standard JSON request for every TanStack Query `queryFn`/`mutationFn`:
 * auth headers, JSON body handling, and uniform error extraction. Non-2xx
 * responses throw `ApiError` with the server's `error` field (or `fallback`).
 *
 * Replaces the per-page `getAuthHeaders` + `fetch` + `if (!res.ok) throw`
 * boilerplate — do not hand-roll that pattern in pages. Reads use it inside
 * `useQuery`, writes inside `useMutation`; see AGENTS.md "Data Fetching".
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
    init.body != null && typeof init.body === 'object' && !(init.body instanceof FormData)
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
