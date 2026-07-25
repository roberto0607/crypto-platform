export type AlertConditionType = "CROSSING" | "CROSSING_UP" | "CROSSING_DOWN";

export type AlertFrequency = "ONCE" | "EVERY_N_MINUTES";

export type AlertStatus = "ACTIVE" | "FIRED" | "EXPIRED" | "CANCELLED";

export type AlertRow = {
  id: string;
  user_id: string;
  pair_id: string;
  condition_type: AlertConditionType;
  target_value: string;
  frequency: AlertFrequency;
  frequency_minutes: number | null;
  last_fired_at: string | null;
  status: AlertStatus;
  expiration: string | null;
  message_template: string | null;
  channels: string[];
  created_at: string;
  updated_at: string;
};
