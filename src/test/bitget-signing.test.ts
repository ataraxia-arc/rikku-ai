import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildBitgetPrehash, canonicalQuery, signBitgetRequest } from "@/lib/bitget/signing";

describe("Bitget UTA request signing", () => {
  it("sorts and URL-encodes query parameters before signing", () => {
    expect(canonicalQuery({ symbol: "BTC/USDT", category: "SPOT", cursor: undefined })).toBe(
      "category=SPOT&symbol=BTC%2FUSDT",
    );
  });

  it("matches the documented timestamp + method + path + query prehash shape", () => {
    const prehash = buildBitgetPrehash({
      timestamp: "16273667805456",
      method: "GET",
      path: "/api/v3/account/fee-rate",
      queryString: "category=SPOT&symbol=BTCUSDT",
    });
    expect(prehash).toBe(
      "16273667805456GET/api/v3/account/fee-rate?category=SPOT&symbol=BTCUSDT",
    );
    expect(signBitgetRequest(prehash, "test-secret")).toBe(
      createHmac("sha256", "test-secret").update(prehash).digest("base64"),
    );
  });
});
