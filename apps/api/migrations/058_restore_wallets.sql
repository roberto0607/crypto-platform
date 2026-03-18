-- ============================================================
-- 058_restore_wallets.sql
-- Restore practice wallets wiped by 057's TRUNCATE CASCADE
-- ============================================================

BEGIN;

-- For every user missing a non-competition USD wallet, create all 4 practice wallets.
-- ON CONFLICT DO NOTHING makes this idempotent.

INSERT INTO wallets (id, user_id, asset_id, balance, reserved, competition_id)
SELECT gen_random_uuid(),
       u.id,
       (SELECT id FROM assets WHERE symbol = 'USD'),
       100000.00,
       0,
       NULL
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.user_id = u.id
      AND w.asset_id = (SELECT id FROM assets WHERE symbol = 'USD')
      AND w.competition_id IS NULL
)
ON CONFLICT DO NOTHING;

INSERT INTO wallets (id, user_id, asset_id, balance, reserved, competition_id)
SELECT gen_random_uuid(),
       u.id,
       (SELECT id FROM assets WHERE symbol = 'BTC'),
       0,
       0,
       NULL
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.user_id = u.id
      AND w.asset_id = (SELECT id FROM assets WHERE symbol = 'BTC')
      AND w.competition_id IS NULL
)
ON CONFLICT DO NOTHING;

INSERT INTO wallets (id, user_id, asset_id, balance, reserved, competition_id)
SELECT gen_random_uuid(),
       u.id,
       (SELECT id FROM assets WHERE symbol = 'ETH'),
       0,
       0,
       NULL
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.user_id = u.id
      AND w.asset_id = (SELECT id FROM assets WHERE symbol = 'ETH')
      AND w.competition_id IS NULL
)
ON CONFLICT DO NOTHING;

INSERT INTO wallets (id, user_id, asset_id, balance, reserved, competition_id)
SELECT gen_random_uuid(),
       u.id,
       (SELECT id FROM assets WHERE symbol = 'SOL'),
       0,
       0,
       NULL
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.user_id = u.id
      AND w.asset_id = (SELECT id FROM assets WHERE symbol = 'SOL')
      AND w.competition_id IS NULL
)
ON CONFLICT DO NOTHING;

COMMIT;
