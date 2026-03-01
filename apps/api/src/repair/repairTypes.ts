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
