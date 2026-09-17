import "server-only";

import { z } from "zod";
import { BitgetGatewayError } from "@/lib/bitget/client";

const SERVER_TIME_URL = "https://api.bitget.com/api/v2/public/time";
const SERVER_TIME_PATH = "/api/v2/public/time";
const serverTimeSchema = z.object({
  code: z.literal("00000"),
  data: z.object({ serverTime: z.union([z.string(), z.number()]) }),
});

export async function getBitgetClockOffset(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<number> {
  const startedAt = now();
  try {
    const response = await fetcher(SERVER_TIME_URL, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const finishedAt = now();
    if (!response.ok) throw new Error("CLOCK_RESPONSE_NOT_OK");
    const parsed = serverTimeSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("CLOCK_RESPONSE_INVALID");
    const serverTime = Number(parsed.data.data.serverTime);
    if (!Number.isSafeInteger(serverTime) || serverTime < 1_000_000_000_000) {
      throw new Error("CLOCK_VALUE_INVALID");
    }
    return Math.round(serverTime - (startedAt + finishedAt) / 2);
  } catch {
    throw new BitgetGatewayError("CLOCK_SYNC_UNAVAILABLE", {
      category: "clock",
      requestPath: SERVER_TIME_PATH,
      durationMs: now() - startedAt,
    });
  }
}
