import type { AskResponse } from "@/lib/ask/types";

/** Persisted response blobs omit the duplicate free-form question. */
export const PERSISTED_ASK_QUESTION = "Ask RIKKU question (content omitted from durable storage)";

const credentialPatterns = [
  /\b(?:api\s*[-_ ]?(?:key|secret|passphrase)|passphrase)\b/i,
  /\b(?:access[-_ ]?(?:sign|key|passphrase|timestamp)|authorization)\b/i,
  /\b(?:bearer|basic)\s+[^\s]{8,}/i,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/i,
  /\b(?:sk|rk)[_-][A-Za-z0-9_-]{12,}\b/i,
  /\bgsk_[A-Za-z0-9_-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Ask never needs opaque identifiers this long. Fail closed on unlabeled,
  // mixed alphanumeric tokens that can otherwise resemble exchange secrets.
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+/,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i,
];

/**
 * Ask RIKKU never needs credentials. Reject credential-shaped text before it
 * can reach an analysis cache, audit record, or any downstream service.
 */
export function containsSensitiveAskInput(value: string) {
  return credentialPatterns.some((pattern) => pattern.test(value));
}

/** Keep generated response blobs free of duplicated user input. */
export function scrubAskResponseForPersistence(response: AskResponse): AskResponse {
  return { ...response, question: PERSISTED_ASK_QUESTION };
}
