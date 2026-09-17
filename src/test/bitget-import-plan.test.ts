import { describe, expect, it } from "vitest";
import { buildTradeImportPlan, createImportWindows } from "@/lib/bitget/import-plan";

describe("Bitget import planning", () => {
  it("splits the 90-day history limit into three 30-day requests", () => {
    const windows = createImportWindows(Date.UTC(2026, 8, 15), 90);
    expect(windows).toHaveLength(3);
    for (const window of windows) {
      expect(Number(window.endTime) - Number(window.startTime)).toBeLessThanOrEqual(30 * 86_400_000);
    }
  });

  it("covers orders, fills, and financial records for every UTA category", () => {
    const plan = buildTradeImportPlan(Date.UTC(2026, 8, 15));
    expect(plan).toHaveLength(45);
    expect(new Set(plan.map((step) => step.endpoint))).toEqual(new Set([
      "/api/v3/trade/history-orders",
      "/api/v3/trade/fills",
      "/api/v3/account/financial-records",
    ]));
  });
});
