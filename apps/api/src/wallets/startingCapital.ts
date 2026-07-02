/**
 * Starting capital shared across free-play and competition funding.
 *
 * A new user's free-play (competition_id IS NULL) USD wallet is credited this
 * amount at signup via a FREE_PLAY_CREDIT ledger entry; competitions default to
 * the same figure for their scoped COMPETITION_CREDIT. Keeping a single constant
 * stops the two paths from silently drifting apart.
 */
export const STARTING_CAPITAL_USD = "100000.00000000";

/** Ledger entry_type for the free-play signup grant (see migration 070). */
export const FREE_PLAY_CREDIT_ENTRY_TYPE = "FREE_PLAY_CREDIT";
