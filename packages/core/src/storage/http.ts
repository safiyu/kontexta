/** Default per-request timeout (short polls are cheap; a hung socket is a fault). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP helper (shared by join / push / pull)
// ---------------------------------------------------------------------------

/** A decoded HTTP response (non-2xx bodies are kept as text for diagnostics). */
export interface FetchJsonResult {
  status: number;
  /** Parsed JSON body (null when the body was not valid JSON). */
  body: unknown;
  /** Raw body text (for error diagnostics). */
  text: string;
}

/** One fetch with a timeout and JSON decode; network errors THROW. */
export async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<FetchJsonResult> {
  const ctrl = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(new Error("request timed out")), timeoutMs);
  // Forward an external abort signal into this request.
  const onExternalAbort = (): void => ctrl.abort(signal?.reason);
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.headers,
      body: init.body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** A short, single-line description of an unknown thrown value. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "AbortError" || /timed out|aborted/i.test(err.message)
      ? `request aborted or timed out (${err.message})`
      : err.message;
  }
  return String(err);
}

