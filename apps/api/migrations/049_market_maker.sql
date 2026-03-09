-- Create market maker bot user for providing liquidity on the order book.
-- The bot places resting LIMIT orders at live Kraken prices so users can trade instantly.

INSERT INTO users (id, email, email_normalized, password_hash, display_name, role)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'mmbot@system.local',
    'mmbot@system.local',
    -- Placeholder hash — bot never logs in via password
    '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
    'Market Maker',
    'USER'
) ON CONFLICT (email_normalized) DO NOTHING;
