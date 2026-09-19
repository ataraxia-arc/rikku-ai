import type { AskResponse } from "@/lib/ask/types";

/** Durable records deliberately omit free-form questions. */
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

/** Keep the response cache useful without retaining a user's free-form text. */
export function scrubAskResponseForPersistence(response: AskResponse): AskResponse {
  return { ...response, question: PERSISTED_ASK_QUESTION };
}
