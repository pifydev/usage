/**
 * Defence in depth for anything this package prints.
 *
 * Nothing here is supposed to see a secret: keys come from pi's own auth
 * resolution and go straight into a header, error bodies are never read, and
 * raw exception text is dropped rather than shown. This scrubber exists for
 * the case where one of those is wrong — a key in a message costs the user a
 * rotation, and the cost of running a regex over a notification is nothing.
 *
 * The patterns describe what to REMOVE. They are never used to find or store
 * a secret. (Idea from imdlan/pi-usage.)
 */

const REDACTED = "[redacted]";

const RULES: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  // Provider key shapes, longest-prefix first.
  { re: /\bsk-or-v1-[A-Za-z0-9]{16,}/g, replacement: REDACTED },
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replacement: REDACTED },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: REDACTED },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replacement: REDACTED },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  // Headers and assignments that name a secret, whatever the value looks like.
  // To end of line, not to the first space: "Bearer <token>" is two words and
  // stopping early leaves exactly the half that matters.
  { re: /\b(?:proxy-)?authorization\s*[:=]\s*[^\r\n;,]+/gi, replacement: `authorization: ${REDACTED}` },
  {
    re: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*["']?[^\s"',;]+/gi,
    replacement: `$1=${REDACTED}`,
  },
  // A URL's query string can carry a token; the path is enough to identify it.
  { re: /(https?:\/\/[^\s?]+)\?[^\s]*/gi, replacement: "$1?[redacted]" },
];

export function redact(text: string): string {
  let out = text ?? "";
  for (const { re, replacement } of RULES) out = out.replace(re, replacement);
  return out;
}
