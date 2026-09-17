import { createHmac } from "node:crypto";

export type QueryValue = string | number | boolean | undefined;

export function canonicalQuery(query: Record<string, QueryValue> = {}) {
  const params = new URLSearchParams();
  Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => params.set(key, String(value)));
  return params.toString();
}

export function buildBitgetPrehash({
  timestamp,
  method,
  path,
  queryString = "",
  body = "",
}: {
  timestamp: string;
  method: "GET";
  path: string;
  queryString?: string;
  body?: string;
}) {
  const requestTarget = queryString ? `${path}?${queryString}` : path;
  return `${timestamp}${method}${requestTarget}${body}`;
}

export function signBitgetRequest(prehash: string, apiSecret: string) {
  return createHmac("sha256", apiSecret).update(prehash).digest("base64");
}
