export type RepairMode = "DRY_RUN" | "APPLY";
export type RepairScope = "USER_ALL_PAIRS" | "USER_PAIR";

export interface RepairPlan {
  targetUserId: string;
  pairId?: string;
  fromTs?: string;
  toTs?: string;
  mode: RepairMode;
}

export interface ComputedPosition {
  pairId: string;
  baseQty: string;
  avgEntryPrice: string;
  realizedPnlQuote: string;
  feesPaidQuote: string;
  tradeCount: number;
  // Scope of the rebuilt row. Derived from the most recent trade's
  // associated order; rebuild is single-scope per (user, pair) and these
  // tag the upsert target. Both default to null = free-play.
  competitionId?: string | null;
  matchId?: string | null;
}

export interface PositionDiff {
  pairId: string;
  field: string;
  expected: string;
  actual: string;
}

export interface PairRepairResult {
  pairId: string;
  computed: ComputedPosition;
  diffs: PositionDiff[];
  applied: boolean;
}

export interface RepairResult {
  repairRunId: string;
  mode: RepairMode;
  changedPairsCount: number;
  updatedPositionsCount: number;
  pairs: PairRepairResult[];
  notes: string[];
}
