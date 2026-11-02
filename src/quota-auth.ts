import { isRecord } from "./types.ts";
import type { QuotaProvider } from "./quota.ts";

interface QuotaRegistry {
  getApiKeyForProvider?: (id: string) => Promise<string | undefined>;
  getProviderAuth?: (id: string) => Promise<{ auth?: { apiKey?: string } } | undefined>;
}

export type QuotaAuthResult =
  | { ok: true; provider: QuotaProvider; apiKey: string }
  | { ok: false; provider: string; reason: string };

/** Bind login authority to API authority; never infer it from an inference token. */
function githubQuotaHost(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "api.github.com";
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash) return null;
    if (url.hostname === "github.com") return "api.github.com";
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/.test(url.hostname)) return `api.${url.hostname}`;
  } catch {
    // An unsupported authority must not fall back to public GitHub.
  }
  return null;
}

/** Resolve token AND endpoint together through Pi's public credential APIs. */
export async function resolveQuotaAuth(
  provider: QuotaProvider,
  registry: QuotaRegistry,
  readCredential: (provider: string) => unknown,
): Promise<QuotaAuthResult> {
  const unavailable = (reason: string): QuotaAuthResult => ({ ok: false, provider: provider.id, reason });
  try {
    if (provider.id === "github-copilot" || provider.id === "openai-codex") {
      const credential = readCredential(provider.id);
      if (!isRecord(credential) || credential.type !== "oauth") return unavailable("Pi OAuth login is required for this subscription quota");
      if (provider.id === "github-copilot") {
        const host = githubQuotaHost(credential.enterpriseUrl);
        if (!host) return unavailable("unsupported GitHub OAuth authority; no quota request was sent");
        // Pi stores the GitHub login token in refresh; access is the inference token.
        const apiKey = typeof credential.refresh === "string" ? credential.refresh.trim() : "";
        if (!apiKey) return unavailable("GitHub OAuth login token is unavailable; the inference token cannot be used");
        return { ok: true, apiKey, provider: {
          ...provider, url: `https://${host}/copilot_internal/user`, allowlist: [host],
        } };
      }
    }
    const direct = await registry.getApiKeyForProvider?.(provider.id);
    const apiKey = direct || (await registry.getProviderAuth?.(provider.id))?.auth?.apiKey || "";
    if (!apiKey.trim()) return unavailable("Pi has no credential for the active provider");
    if (provider.id === "openai-codex") {
      // A stored login must not authorize forwarding an unrelated resolved API key.
      const refreshed = readCredential(provider.id);
      if (!isRecord(refreshed) || refreshed.type !== "oauth" || refreshed.access !== apiKey) {
        return unavailable("resolved credential does not match the Codex OAuth login; no quota request was sent");
      }
    }
    return { ok: true, apiKey, provider };
  } catch {
    return unavailable("Pi credential resolution failed; no quota request was sent");
  }
}
