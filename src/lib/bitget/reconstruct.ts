import { createHash } from "node:crypto";

// Numeric columns are persisted as decimal strings. BigInt avoids binary float
// drift while allocating partial fills and fees at the database's 18dp scale.
const SCALE = 10n ** 18n;
const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,18}))?$/;
const FUTURES = new Set(["USDT-FUTURES", "USDC-FUTURES"]);

export type NormalizedTradeFill = {
  external_execution_id: string;
  external_order_id: string | null;
  category: string;
  symbol: string;
  side: string;
  trade_side: string | null;
  execution_price: string | null;
  execution_quantity: string | null;
  execution_value: string | null;
  execution_pnl: string | null;
  fee_amount: string | null;
  fee_coin: string | null;
  executed_at: string;
};

export type ReconstructedTrade = {
  reconstruction_key: string;
  category: string;
  symbol: string;
  direction: "long" | "short";
  opened_at: string;
  closed_at: string;
  quantity: string;
  entry_price: string;
  exit_price: string;
  gross_pnl: string | null;
  net_pnl: string | null;
  fees: string | null;
  funding: null;
  reconstruction_quality: "observed_fills" | "gross_only";
  reconstruction_version: "fifo-v1";
  fillAllocations: { external_execution_id: string; allocated_quantity: string }[];
};

export type ReconstructionWarning = {
  code:
    | "INVALID_FILL"
    | "DUPLICATE_EXECUTION_CONFLICT"
    | "UNSUPPORTED_CATEGORY"
    | "SPOT_OPENING_INVENTORY_UNPROVEN"
    | "AMBIGUOUS_SAME_TIMESTAMP"
    | "AMBIGUOUS_TRADE_SIDE"
    | "UNMATCHED_CLOSE"
    | "MISSING_EXECUTION_PNL"
    | "FEE_NOT_CONVERTIBLE";
  category?: string;
  symbol?: string;
  externalExecutionId?: string;
};

export type ReconstructionResult = {
  trades: ReconstructedTrade[];
  warnings: ReconstructionWarning[];
};

export type ReconstructionOptions = {
  // Evidence from outside the bounded fill window is required before SPOT
  // sells can be asserted to close buys seen within this window.
  openingSpotInventoryKnownZero?: boolean;
};

type ParsedFill = NormalizedTradeFill & {
  category: string;
  symbol: string;
  side: "buy" | "sell";
  trade_side: string | null;
  execution_price: string;
  execution_quantity: string;
  price: bigint;
  quantity: bigint;
  pnl: bigint | null;
  fee: bigint | null;
  time: number;
};

type Lot = {
  fill: ParsedFill;
  remainingQuantity: bigint;
  remainingFee: bigint | null;
};

function decimal(value: string | null): bigint | null {
  if (value === null) return null;
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const magnitude = BigInt(match[2]) * SCALE + BigInt((match[3] ?? "").padEnd(18, "0"));
  return match[1] === "-" ? -magnitude : magnitude;
}

function decimalString(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / SCALE;
  const fractional = (magnitude % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fractional ? `.${fractional}` : ""}`;
}

function quoteCoin(category: string, symbol: string): string | null {
  if (category === "USDT-FUTURES") return "USDT";
  if (category === "USDC-FUTURES") return "USDC";
  const clean = symbol.replace(/[/-]/g, "");
  for (const suffix of ["USDT", "USDC", "USD", "BTC", "ETH"]) {
    if (clean.endsWith(suffix) && clean.length > suffix.length) return suffix;
  }
  return null;
}

function parseFill(fill: NormalizedTradeFill): ParsedFill | null {
  const price = decimal(fill.execution_price);
  const quantity = decimal(fill.execution_quantity);
  const pnl = decimal(fill.execution_pnl);
  const fee = decimal(fill.fee_amount);
  const time = Date.parse(fill.executed_at);
  const side = fill.side.toLowerCase();
  if (!fill.external_execution_id || !fill.category || !fill.symbol || !Number.isFinite(time)
    || !price || !quantity || price <= 0n || quantity <= 0n
    || (side !== "buy" && side !== "sell")
    || (fill.execution_pnl !== null && pnl === null)
    || (fill.fee_amount !== null && fee === null)) return null;
  return {
    ...fill,
    category: fill.category.toUpperCase(),
    symbol: fill.symbol.toUpperCase(),
    side,
    trade_side: fill.trade_side?.toLowerCase() ?? null,
    execution_price: fill.execution_price!,
    execution_quantity: fill.execution_quantity!,
    price,
    quantity,
    pnl,
    fee,
    time,
  };
}

function feeCost(fill: ParsedFill, settlementCoin: string | null): bigint | null {
  if (fill.fee === null || fill.fee < 0n) return null;
  if (fill.fee === 0n) return 0n;
  if (!settlementCoin || fill.fee_coin?.toUpperCase() !== settlementCoin) return null;
  return fill.fee;
}

function role(fill: ParsedFill): { action: "open" | "close"; direction: "long" | "short" } | null {
  if (fill.category === "SPOT") return fill.side === "buy"
    ? { action: "open", direction: "long" }
    : { action: "close", direction: "long" };
  if (fill.trade_side === "open") return { action: "open", direction: fill.side === "buy" ? "long" : "short" };
  if (fill.trade_side === "close") return { action: "close", direction: fill.side === "sell" ? "long" : "short" };
  return null;
}

function sameTimestampAmbiguity(fills: ParsedFill[]) {
  const seen = new Set<string>();
  for (const fill of fills) {
    const classification = role(fill);
    if (!classification) continue;
    const key = `${classification.action}|${classification.direction}|${fill.time}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function reconstructClosedTrades(
  fills: readonly NormalizedTradeFill[],
  options: ReconstructionOptions = {},
): ReconstructionResult {
  const warnings: ReconstructionWarning[] = [];
  const trades: ReconstructedTrade[] = [];
  const byExecutionId = new Map<string, NormalizedTradeFill>();
  const conflictingIds = new Set<string>();

  for (const fill of fills) {
    const previous = byExecutionId.get(fill.external_execution_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(fill)) {
      conflictingIds.add(fill.external_execution_id);
      warnings.push({ code: "DUPLICATE_EXECUTION_CONFLICT", externalExecutionId: fill.external_execution_id });
    } else if (!previous) byExecutionId.set(fill.external_execution_id, fill);
  }

  const groups = new Map<string, ParsedFill[]>();
  for (const [id, fill] of byExecutionId) {
    if (conflictingIds.has(id)) continue;
    const parsed = parseFill(fill);
    if (!parsed) {
      warnings.push({ code: "INVALID_FILL", externalExecutionId: id });
      continue;
    }
    const key = `${parsed.category}\u0000${parsed.symbol}`;
    const group = groups.get(key) ?? [];
    group.push(parsed);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.time - b.time || a.external_execution_id.localeCompare(b.external_execution_id));
    const { category, symbol } = group[0];
    if (category === "SPOT" && !options.openingSpotInventoryKnownZero) {
      warnings.push({ code: "SPOT_OPENING_INVENTORY_UNPROVEN", category, symbol });
      continue;
    }
    if (category !== "SPOT" && !FUTURES.has(category)) {
      warnings.push({ code: "UNSUPPORTED_CATEGORY", category, symbol });
      continue;
    }
    if (sameTimestampAmbiguity(group)) {
      warnings.push({ code: "AMBIGUOUS_SAME_TIMESTAMP", category, symbol });
      continue;
    }

    const settlementCoin = quoteCoin(category, symbol);
    const lots: Record<"long" | "short", Lot[]> = { long: [], short: [] };

    for (const fill of group) {
      const classification = role(fill);
      if (!classification) {
        warnings.push({ code: "AMBIGUOUS_TRADE_SIDE", category, symbol, externalExecutionId: fill.external_execution_id });
        continue;
      }
      const queue = lots[classification.direction];
      if (classification.action === "open") {
        queue.push({ fill, remainingQuantity: fill.quantity, remainingFee: feeCost(fill, settlementCoin) });
        continue;
      }

      const available = queue.filter((lot) => lot.fill.time < fill.time)
        .reduce((total, lot) => total + lot.remainingQuantity, 0n);
      if (available < fill.quantity) {
        warnings.push({ code: "UNMATCHED_CLOSE", category, symbol, externalExecutionId: fill.external_execution_id });
        // The observed inventory was consumed, but an earlier position is
        // unknown; keeping these lots could misattribute subsequent closes.
        queue.length = 0;
        continue;
      }

      let remaining = fill.quantity;
      let entryNotional = 0n;
      let openFees: bigint | null = 0n;
      let openedAt = fill.executed_at;
      const allocations: ReconstructedTrade["fillAllocations"] = [];
      while (remaining > 0n) {
        const lot = queue[0];
        const allocated = remaining < lot.remainingQuantity ? remaining : lot.remainingQuantity;
        if (allocations.length === 0) openedAt = lot.fill.executed_at;
        entryNotional += allocated * lot.fill.price / SCALE;
        allocations.push({ external_execution_id: lot.fill.external_execution_id, allocated_quantity: decimalString(allocated) });
        if (lot.remainingFee === null) openFees = null;
        else {
          const allocatedFee = allocated === lot.remainingQuantity
            ? lot.remainingFee
            : lot.remainingFee * allocated / lot.remainingQuantity;
          lot.remainingFee -= allocatedFee;
          if (openFees !== null) openFees += allocatedFee;
        }
        lot.remainingQuantity -= allocated;
        remaining -= allocated;
        if (lot.remainingQuantity === 0n) queue.shift();
      }

      const closingFee = feeCost(fill, settlementCoin);
      const fees = openFees === null || closingFee === null ? null : openFees + closingFee;
      if (fees === null) warnings.push({ code: "FEE_NOT_CONVERTIBLE", category, symbol, externalExecutionId: fill.external_execution_id });
      const gross = category === "SPOT"
        ? fill.quantity * fill.price / SCALE - entryNotional
        : fill.pnl;
      if (gross === null) warnings.push({ code: "MISSING_EXECUTION_PNL", category, symbol, externalExecutionId: fill.external_execution_id });
      const net = gross === null || fees === null ? null : gross - fees;
      const averageEntryPrice = entryNotional * SCALE / fill.quantity;
      allocations.push({ external_execution_id: fill.external_execution_id, allocated_quantity: decimalString(fill.quantity) });
      trades.push({
        reconstruction_key: createHash("sha256").update(`fifo-v1\u0000${category}\u0000${symbol}\u0000${fill.external_execution_id}`).digest("hex"),
        category,
        symbol,
        direction: classification.direction,
        opened_at: openedAt,
        closed_at: fill.executed_at,
        quantity: decimalString(fill.quantity),
        entry_price: decimalString(averageEntryPrice),
        exit_price: decimalString(fill.price),
        gross_pnl: gross === null ? null : decimalString(gross),
        net_pnl: net === null ? null : decimalString(net),
        fees: fees === null ? null : decimalString(fees),
        funding: null,
        reconstruction_quality: net === null ? "gross_only" : "observed_fills",
        reconstruction_version: "fifo-v1",
        fillAllocations: allocations,
      });
    }
  }

  trades.sort((a, b) => a.closed_at.localeCompare(b.closed_at) || a.reconstruction_key.localeCompare(b.reconstruction_key));
  return { trades, warnings };
}
