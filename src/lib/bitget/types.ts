import { z } from "zod";

export const bitgetCredentialsSchema = z.object({
  apiKey: z.string().min(8).max(256).refine((value) => value === value.trim() && !/[\r\n]/.test(value)),
  apiSecret: z.string().min(8).max(256).refine((value) => value.trim().length >= 8 && !/[\r\n]/.test(value)),
  passphrase: z.string().min(1).max(128).refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value)),
});

export type BitgetCredentials = z.infer<typeof bitgetCredentialsSchema>;

export const bitgetAccountInfoSchema = z.object({
  userId: z.string().min(1),
  permType: z.unknown(),
  permissions: z.array(z.string()),
}).passthrough();

export type BitgetAccountInfo = z.infer<typeof bitgetAccountInfoSchema>;

export const bitgetOrderSchema = z.object({
  orderId: z.string().min(1),
  clientOid: z.string().optional(),
  category: z.string().min(1),
  symbol: z.string().min(1),
  orderType: z.string().optional(),
  side: z.string().min(1),
  price: z.string().optional(),
  qty: z.string().optional(),
  cumExecQty: z.string().optional(),
  cumExecValue: z.string().optional(),
  avgPrice: z.string().optional(),
  orderStatus: z.string().optional(),
  posSide: z.string().optional(),
  tradeSide: z.string().optional(),
  marginMode: z.string().optional(),
  reduceOnly: z.string().optional(),
  createdTime: z.string().min(1),
  updatedTime: z.string().optional(),
});

export const bitgetFillSchema = z.object({
  execId: z.string().min(1),
  execLinkId: z.string().optional(),
  orderId: z.string().optional(),
  category: z.string().min(1),
  symbol: z.string().min(1),
  side: z.string().min(1),
  tradeSide: z.string().optional(),
  tradeScope: z.string().optional(),
  execPrice: z.string().min(1),
  execQty: z.string().min(1),
  execValue: z.string().optional(),
  execPnl: z.string().optional(),
  feeDetail: z
    .array(z.object({ feeCoin: z.string().nullable().optional(), fee: z.string().nullable().optional() }))
    .default([]),
  createdTime: z.string().min(1),
  updatedTime: z.string().optional(),
});

export const bitgetCategories = [
  "SPOT",
  "MARGIN",
  "USDT-FUTURES",
  "COIN-FUTURES",
  "USDC-FUTURES",
] as const;

export type BitgetCategory = (typeof bitgetCategories)[number];
