-- Phase 14 PR2: Competition system tables

-- ═══ competitions ═══
CREATE TABLE competitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    starting_balance_usd NUMERIC(28, 8) NOT NULL DEFAULT 100000.00000000,
    status TEXT NOT NULL DEFAULT 'UPCOMING'
        CHECK (status IN ('UPCOMING', 'ACTIVE', 'ENDED', 'CANCELLED')),
    max_participants INT,
    pairs_allowed JSONB NOT NULL DEFAULT '"all"',
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT competitions_dates_check CHECK (end_at > start_at)
);

CREATE INDEX idx_competitions_status ON competitions(status);
CREATE INDEX idx_competitions_start_at ON competitions(start_at) WHERE status = 'UPCOMING';

-- ═══ competition_participants ═══
CREATE TABLE competition_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    starting_equity NUMERIC(28, 8) NOT NULL,
    final_equity NUMERIC(28, 8),
    final_return_pct NUMERIC(12, 4),
    final_max_drawdown_pct NUMERIC(12, 4),
    final_rank INT,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'DISQUALIFIED', 'WITHDRAWN')),
    CONSTRAINT competition_participants_unique UNIQUE (competition_id, user_id)
);

CREATE INDEX idx_comp_participants_user ON competition_participants(user_id);
CREATE INDEX idx_comp_participants_comp ON competition_participants(competition_id);

-- ═══ competition_leaderboard (cache) ═══
CREATE TABLE competition_leaderboard (
    competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rank INT NOT NULL,
    equity NUMERIC(28, 8) NOT NULL,
    return_pct NUMERIC(12, 4) NOT NULL,
    max_drawdown_pct NUMERIC(12, 4) NOT NULL DEFAULT 0,
    current_drawdown_pct NUMERIC(12, 4) NOT NULL DEFAULT 0,
    trades_count INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (competition_id, user_id)
);

-- ═══ FK from wallets.competition_id → competitions.id ═══
ALTER TABLE wallets
    ADD CONSTRAINT wallets_competition_fk
    FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE;

-- ═══ FK from orders.competition_id → competitions.id ═══
ALTER TABLE orders
    ADD CONSTRAINT orders_competition_fk
    FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE;

-- ═══ FK from positions.competition_id → competitions.id ═══
ALTER TABLE positions
    ADD CONSTRAINT positions_competition_fk
    FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE;

-- ═══ FK from equity_snapshots.competition_id → competitions.id ═══
ALTER TABLE equity_snapshots
    ADD CONSTRAINT equity_snapshots_competition_fk
    FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE;
