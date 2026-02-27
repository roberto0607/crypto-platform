export type TriggerKind =
  | "STOP_MARKET"
  | "STOP_LIMIT"
  | "TAKE_PROFIT_MARKET"
  | "TAKE_PROFIT_LIMIT";

export type TriggerStatus =
  | "ACTIVE"
  | "TRIGGERED"
  | "CANCELED"
  | "EXPIRED"
  | "FAILED";

export type TriggerOrderRow = {
  id: string;
  user_id: string;
  pair_id: string;
  kind: TriggerKind;
  side: "BUY" | "SELL";
  trigger_price: string;
  limit_price: string | null;
  qty: string;
  status: TriggerStatus;
  oco_group_id: string | null;
  derived_order_id: string | null;
  fail_reason: string | null;
  created_at: string;
  updated_at: string;
};
