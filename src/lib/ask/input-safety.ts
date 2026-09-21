import type { AskResponse } from "@/lib/ask/types";

/** Persisted response blobs omit the duplicate free-form question. */
export const PERSISTED_ASK_QUESTION = "Ask RIKKU question (content omitted from durable storage)";

const credentialPatterns = [
  /\b(?:api\s*[-_ ]?(?:key|secret|passphrase)|passphrase)\b/i,
  /\b(?:access[-_ ]?(?:sign|key|passphrase|timestamp)|authorization)\b/i,
  /\b(?:bearer|basic)\s+[^\s]{8,}/i,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/i,
  /\b(?:sk|rk)_[A-Za-z0-9_-]{12,}\b/i,
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
