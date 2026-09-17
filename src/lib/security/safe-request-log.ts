import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

type BitgetOperation = "connection.verify" | "connection.status" | "connection.disconnect" | "import.start" | "import.status";

export async function withSafeRequestLog(
  operation: BitgetOperation,
  handler: (requestId: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let response: NextResponse;

  try {
    response = await handler(requestId);
  } catch {
    // Do not log an exception object: upstream libraries may embed headers or credentials.
    response = NextResponse.json({ ok: false, code: "INTERNAL_ERROR" }, { status: 500 });
  }

  response.headers.set("X-Request-ID", requestId);
  response.headers.set("Cache-Control", "no-store");
  const record = JSON.stringify({
    event: "rikku.bitget.request",
    requestId,
    operation,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  if (response.status >= 400) console.warn(record);
  else console.info(record);
  return response;
}
