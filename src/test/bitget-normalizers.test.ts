import { describe, expect, it } from "vitest";
import { normalizeBitgetFill, normalizeBitgetOrder } from "@/lib/bitget/normalizers";

describe("Bitget normalization", () => {
  it("preserves exact decimal strings in order records", () => {
    const normalized = normalizeBitgetOrder({
      orderId: "111",
      category: "USDT-FUTURES",
      symbol: "btcusdt",
      side: "BUY",
      qty: "0.010000000000000001",
      cumExecQty: "0.01",
      cumExecValue: "495.344",
      avgPrice: "49534.4",
      reduceOnly: "NO",
      createdTime: "1730181468493",
    });

    expect(normalized.requested_quantity).toBe("0.010000000000000001");
    expect(normalized.symbol).toBe("BTCUSDT");
    expect(normalized.reduce_only).toBe(false);
    expect(normalized.source_created_at).toBe("2024-10-29T05:57:48.493Z");
  });

  it("normalizes fill fees without using floating-point arithmetic", () => {
    const normalized = normalizeBitgetFill({
      execId: "222",
      orderId: "111",
      category: "SPOT",
      symbol: "ETHUSDT",
      side: "sell",
      execPrice: "106950.1",
      execQty: "0.01",
      execValue: "1069.501",
      execPnl: "-0.002",
      feeDetail: [{ feeCoin: "USDT", fee: "0.6417006" }],
      createdTime: "1750141421721",
    });
    expect(normalized.fee_amount).toBe("0.6417006");
    expect(normalized.execution_pnl).toBe("-0.002");
  });

  it("rejects malformed numeric values", () => {
    expect(() => normalizeBitgetOrder({
      orderId: "111",
      category: "SPOT",
      symbol: "BTCUSDT",
      side: "buy",
      qty: "not-a-number",
      createdTime: "1730181468493",
    })).toThrow("INVALID_DECIMAL");
  });
});
