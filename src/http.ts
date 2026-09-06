/**
 * The one networked path in this package, made boring on purpose.
 *
 * A quota call carries the user's provider key in an Authorization header, so
 * the request has to be pinned down rather than merely aimed at the right URL:
 *
 *  - HTTPS only, and the host must be on the caller's allowlist. A typo or a
 *    future edit cannot point a credentialed request somewhere new.
 *  - Redirects are refused outright (`redirect: "error"`). Following one means
 *    a provider — or anything that can answer as one — chooses where the next
 *    request goes, with the header already attached.
 *  - A non-2xx body is never read. Error bodies echo request details back, and
 *    an echoed Authorization header pasted into a notification is exactly the
 *    leak this package must not cause. The status alone is the message.
 *  - Everything is classified into a small set of reasons, so the caller can
 *    say something useful without carrying provider text around.
 *
 * `fetchImpl` is injectable so tests never touch the network.
 *
 * (Structure and the no-body-on-error rule are from imdlan/pi-usage.)
 */

export type HttpFailureKind =
  | "unsafe-url"
  | "not-allowed"
  | "auth"
  | "forbidden"
  | "rate-limited"
  | "server"
  | "http"
  | "timeout"
  | "network"
  | "invalid-json";

export interface HttpFailure {
  ok: false;
  kind: HttpFailureKind;
  reason: string;
  status?: number;
}

export interface HttpSuccess<T> {
  ok: true;
  status: number;
  data: T;
}

export type HttpResult<T> = HttpSuccess<T> | HttpFailure;

export interface ControlledGetOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  allowlist: readonly string[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const TIMEOUT_SENTINEL = "pify-usage-timeout";

function fail(kind: HttpFailureKind, reason: string, status?: number): HttpFailure {
  return { ok: false, kind, reason, ...(status === undefined ? {} : { status }) };
}

/** Reject anything that is not an allowlisted HTTPS host before dialling. */
export function checkUrl(url: string, allowlist: readonly string[]): HttpFailure | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("unsafe-url", "invalid url");
  }
  if (parsed.protocol !== "https:") return fail("unsafe-url", "refused a non-HTTPS url");
  if (!allowlist.includes(parsed.hostname)) {
    return fail("not-allowed", `host ${parsed.hostname} is not on the allowlist`);
  }
  return null;
}

export function classifyStatus(status: number): HttpFailure {
  if (status === 401) return fail("auth", "the provider rejected the key", status);
  if (status === 403) return fail("forbidden", "the key is not allowed to read usage", status);
  if (status === 429) return fail("rate-limited", "rate limited by the provider", status);
  if (status >= 500) return fail("server", "the provider is having trouble", status);
  return fail("http", `HTTP ${status}`, status);
}

/** GET JSON from an allowlisted host. Never throws; failure is a value. */
export async function controlledGetJson<T = unknown>(opts: ControlledGetOptions): Promise<HttpResult<T>> {
  const urlProblem = checkUrl(opts.url, opts.allowlist);
  if (urlProblem) return urlProblem;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(TIMEOUT_SENTINEL)), opts.timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);

  let response: Response;
  try {
    response = await doFetch(opts.url, {
      method: "GET",
      headers: opts.headers ?? {},
      signal: controller.signal,
      redirect: "error",
    });
  } catch (err) {
    if (controller.signal.aborted) {
      const timedOut = String(controller.signal.reason ?? "").includes(TIMEOUT_SENTINEL);
      return timedOut ? fail("timeout", "the provider did not answer in time") : fail("network", "request aborted");
    }
    const message = String((err as { message?: unknown })?.message ?? err).toLowerCase();
    if (message.includes("redirect")) return fail("unsafe-url", "the provider tried to redirect us");
    if (message.includes("timeout") || message.includes("timed out")) {
      return fail("timeout", "the provider did not answer in time");
    }
    // The raw error is deliberately dropped: it can carry the request, and the
    // request carries the key.
    return fail("network", "could not reach the provider");
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 200 && response.status < 300) {
    try {
      return { ok: true, status: response.status, data: (await response.json()) as T };
    } catch {
      return fail("invalid-json", "the provider sent something that is not JSON", response.status);
    }
  }
  return classifyStatus(response.status);
}
