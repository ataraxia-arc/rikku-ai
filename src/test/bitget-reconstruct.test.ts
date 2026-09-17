import { describe, expect, it } from "vitest";
import { reconstructClosedTrades, type NormalizedTradeFill } from "@/lib/bitget/reconstruct";

const open: NormalizedTradeFill = {
  external_execution_id: "open-1",
  external_order_id: "order-1",
  category: "USDT-FUTURES",
  symbol: "BTCUSDT",
  side: "buy",
  trade_side: "open",
  execution_price: "100",
  execution_quantity: "2",
  execution_value: "200",
  execution_pnl: "0",
  fee_amount: "0.2",
  fee_coin: "USDT",
  executed_at: "2026-09-01T00:00:00.000Z",
};

const close: NormalizedTradeFill = {
  ...open,
  external_execution_id: "close-1",
  external_order_id: "order-2",
  side: "sell",
  trade_side: "close",
  execution_price: "110",
  execution_value: "220",
  execution_pnl: "20",
  fee_amount: "0.2",
  executed_at: "2026-09-02T00:00:00.000Z",
};

describe("deterministic closed-trade reconstruction", () => {
  it("links observed futures fills and subtracts settlement-currency fees", () => {
    const result = reconstructClosedTrades([close, open]);
    expect(result.warnings).toEqual([]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      category: "USDT-FUTURES", symbol: "BTCUSDT", direction: "long",
      quantity: "2", gross_pnl: "20", fees: "0.4", net_pnl: "19.6",
      reconstruction_quality: "observed_fills",
    });
    expect(reconstructClosedTrades([open, close]).trades[0].reconstruction_key)
      .toBe(result.trades[0].reconstruction_key);
  });

  it("refuses to invent SPOT opening inventory outside the data window", () => {
    const result = reconstructClosedTrades([{ ...open, category: "SPOT" }, { ...close, category: "SPOT" }]);
    expect(result.trades).toHaveLength(0);
    expect(result.warnings).toContainEqual({
      code: "SPOT_OPENING_INVENTORY_UNPROVEN", category: "SPOT", symbol: "BTCUSDT",
    });
  });

  it("does not fabricate net P&L when fee currency cannot be converted", () => {
    const result = reconstructClosedTrades([open, { ...close, fee_coin: "BGB" }]);
    expect(result.trades[0].gross_pnl).toBe("20");
    expect(result.trades[0].net_pnl).toBeNull();
    expect(result.warnings.some((warning) => warning.code === "FEE_NOT_CONVERTIBLE")).toBe(true);
  });
});
