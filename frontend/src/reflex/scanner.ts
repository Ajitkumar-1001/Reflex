/*
 * Deterministic scans for the write gate (PRD §9.3, §17.1). Both are pattern based and fail toward review:
 * the model classifier that the PRD pairs with them is DEC-12, and these scans are the part that must work
 * without it.
 */

export interface ScanFinding {
  code: string;
  detail: string;
}

const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const BASE64_BLOB = /[A-Za-z0-9+/]{40,}={0,2}/g;

/** Strips zero-width and bidi control characters (also applied before text enters a prompt). */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

export interface Normalized {
  /** Visible text with invisible characters removed, HTML comments removed, and decoded blobs and comment bodies appended for scanning. */
  text: string;
  /** Codes for content that is suspicious by its mere presence (PRD §9.3: presence alone forces review). */
  hidden: ScanFinding[];
}

export function normalizeForScan(input: string): Normalized {
  const hidden: ScanFinding[] = [];
  if (input.search(INVISIBLE) >= 0) hidden.push({ code: "hidden_content", detail: "zero-width or bidi control characters" });
  let text = stripInvisible(input);

  const comments = text.match(HTML_COMMENT) ?? [];
  if (comments.length > 0) hidden.push({ code: "hidden_content", detail: "HTML comment" });
  text = text.replace(HTML_COMMENT, " ");
  const extra = comments.map((c) => c.slice(4, -3));

  for (const blob of text.match(BASE64_BLOB) ?? []) {
    const decoded = Buffer.from(blob, "base64").toString("utf8");
    if (/^[\x20-\x7E\s]+$/.test(decoded) && decoded.length >= 20) {
      hidden.push({ code: "hidden_content", detail: "base64-encoded text" });
      extra.push(decoded);
    }
  }
  return { text: [text, ...extra].join("\n"), hidden };
}

// ------------------------------------------------------------------- secrets

const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "api_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "credential_assignment", pattern: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|passwd)\s*[:=]\s*['"]?[^\s'"]{8,}/i },
  { name: "email_address", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

function entropy(token: string): number {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / token.length) * Math.log2(n / token.length);
  return bits;
}

const decodesToText = (token: string): boolean => {
  const decoded = Buffer.from(token, "base64").toString("utf8");
  return decoded.length >= 20 && /^[\x20-\x7E\s]+$/.test(decoded);
};

const HIGH_ENTROPY_MIN_LENGTH = 24;
const HIGH_ENTROPY_BITS = 4.2; // above the 4.0 ceiling of hex digests, so content hashes are not flagged

/** Pattern plus entropy secret and PII scan over already-normalized text. */
export function scanSecrets(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) findings.push({ code: "secret_detected", detail: name });
  }
  for (const token of text.split(/[\s,;()"'`<>[\]{}]+/)) {
    // Base64 that decodes to readable text is hidden content, which normalization reports for review; random bytes are secrets.
    if (token.length >= HIGH_ENTROPY_MIN_LENGTH && /^[A-Za-z0-9+/=_-]+$/.test(token) && entropy(token) >= HIGH_ENTROPY_BITS && !decodesToText(token)) {
      findings.push({ code: "secret_detected", detail: "high_entropy_token" });
    }
  }
  return findings;
}

// -------------------------------------------------- instruction elevation

const INSTRUCTION_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "override_instructions", pattern: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|system|policy|polic(?:y|ies))\b[^.\n]{0,30}\b(?:instructions?|rules?|prompts?|polic(?:y|ies))\b/i },
  { name: "always_run", pattern: /\balways\s+(?:run|execute|call|use)\b/i },
  { name: "network_fetch", pattern: /\b(?:curl|wget)\b|\bhttps?:\/\//i },
  { name: "pipe_to_shell", pattern: /\|\s*(?:sh|bash|zsh)\b/ },
  { name: "privileged_command", pattern: /\bsudo\b|\brm\s+-rf\b|\bchmod\s+777\b/i },
  { name: "permission_change", pattern: /\b(?:grant|allow|enable|bypass|disable|skip|ignore|turn off|remove)\b[^.\n]{0,30}\b(?:permissions?|approval|authori[sz]ation|sandbox|allowlist|protected paths?|safety|checks?|tests?)\b/i },
  { name: "external_write", pattern: /\bgit\s+push\b|\bforce[- ]push\b|\bpublish\b[^.\n]{0,20}\bpackage\b/i },
  { name: "secret_exfiltration", pattern: /\b(?:send|post|upload|exfiltrate|print|echo)\b[^.\n]{0,40}\b(?:secrets?|credentials?|tokens?|api keys?|env(?:ironment)? vars?)\b/i },
];

/** Normalizes first (PRD §9.3), then applies the deny-list. Hidden content is itself a finding. */
export function scanInstructionElevation(text: string): ScanFinding[] {
  const { text: normalized, hidden } = normalizeForScan(text);
  const hits = INSTRUCTION_PATTERNS.filter(({ pattern }) => pattern.test(normalized)).map(({ name }) => ({
    code: "instruction_elevation",
    detail: name,
  }));
  return [...hidden, ...hits];
}
