import { bitgetFillSchema, bitgetOrderSchema } from "@/lib/bitget/types";

const decimalPattern = /^-?(?:\d+\.?\d*|\.\d+)$/;

function decimalOrNull(value: string | undefined | null) {
  if (value === undefined || value === null || value === "") return null;
  if (!decimalPattern.test(value)) throw new Error("INVALID_DECIMAL");
  return value;
}

function timestampToIso(value: string) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("INVALID_TIMESTAMP");
  return new Date(timestamp).toISOString();
}

export function normalizeBitgetOrder(input: unknown) {
  const order = bitgetOrderSchema.parse(input);
  return {
    external_order_id: order.orderId,
    client_order_id: order.clientOid ?? null,
    category: order.category.toUpperCase(),
    symbol: order.symbol.toUpperCase(),
    side: order.side.toLowerCase(),
    order_type: order.orderType ?? null,
    order_status: order.orderStatus ?? null,
    position_side: order.posSide ?? null,
    trade_side: order.tradeSide ?? null,
    margin_mode: order.marginMode ?? null,
    reduce_only: order.reduceOnly ? order.reduceOnly.toUpperCase() === "YES" : null,
    requested_quantity: decimalOrNull(order.qty),
    executed_quantity: decimalOrNull(order.cumExecQty),
    executed_value: decimalOrNull(order.cumExecValue),
    requested_price: decimalOrNull(order.price),
    average_price: decimalOrNull(order.avgPrice),
    source_created_at: timestampToIso(order.createdTime),
    source_updated_at: order.updatedTime ? timestampToIso(order.updatedTime) : null,
    raw_schema_version: "bitget-uta-v3-2026-09",
  };
}

export function normalizeBitgetFill(input: unknown) {
  const fill = bitgetFillSchema.parse(input);
  const primaryFee = fill.feeDetail.find((fee) => fee.fee !== null && fee.fee !== undefined);
  return {
    external_execution_id: fill.execId,
    external_order_id: fill.orderId ?? null,
    execution_link_id: fill.execLinkId ?? null,
    category: fill.category.toUpperCase(),
    symbol: fill.symbol.toUpperCase(),
    side: fill.side.toLowerCase(),
    trade_side: fill.tradeSide ?? null,
    liquidity_role: fill.tradeScope ?? null,
    execution_price: decimalOrNull(fill.execPrice),
    execution_quantity: decimalOrNull(fill.execQty),
    execution_value: decimalOrNull(fill.execValue),
    execution_pnl: decimalOrNull(fill.execPnl),
    fee_amount: decimalOrNull(primaryFee?.fee),
    fee_coin: primaryFee?.feeCoin ?? null,
    executed_at: timestampToIso(fill.createdTime),
    raw_schema_version: "bitget-uta-v3-2026-09",
  };
}
