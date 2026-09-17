import { bitgetCategories, type BitgetCategory } from "@/lib/bitget/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ImportWindow = { startTime: string; endTime: string };

export function createImportWindows(endMs: number, totalDays = 90): ImportWindow[] {
  if (!Number.isFinite(endMs) || totalDays < 1 || totalDays > 90) {
    throw new Error("INVALID_IMPORT_WINDOW");
  }

  const windows: ImportWindow[] = [];
  let remainingDays = totalDays;
  let windowEnd = Math.floor(endMs);

  while (remainingDays > 0) {
    const days = Math.min(30, remainingDays);
    const windowStart = windowEnd - days * DAY_MS;
    windows.unshift({ startTime: String(windowStart), endTime: String(windowEnd) });
    windowEnd = windowStart - 1;
    remainingDays -= days;
  }

  return windows;
}

export function buildTradeImportPlan(endMs: number) {
  const windows = createImportWindows(endMs);
  return bitgetCategories.flatMap((category: BitgetCategory) =>
    windows.flatMap((window) => [
      { endpoint: "/api/v3/trade/history-orders" as const, category, ...window },
      { endpoint: "/api/v3/trade/fills" as const, category, ...window },
      { endpoint: "/api/v3/account/financial-records" as const, category, ...window },
    ]),
  );
}
