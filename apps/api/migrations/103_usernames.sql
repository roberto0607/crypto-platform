-- Real usernames. display_name becomes the unique public handle, so nothing
-- shown to other players has to fall back to the email address any more.
--
-- username_chosen_at is NULL for anyone who still holds a generated default;
-- the web app uses it to ask them to pick a name.
--
-- The reserved list here must match RESERVED_USERNAMES in auth/username.ts
-- (migration103Usernames.test.ts seeds every entry of that set).

ALTER TABLE users ADD COLUMN IF NOT EXISTS username_chosen_at TIMESTAMPTZ;

-- The bots' names have spaces. Rename them first so they end up valid; both
-- names are reserved, so no user can hold or take them.
UPDATE users SET display_name = 'market_maker', username_chosen_at = now()
 WHERE email_normalized = 'mmbot@system.local';
UPDATE users SET display_name = 'risk_agent', username_chosen_at = now()
 WHERE email_normalized = 'riskagent@system.local';

-- Keep a name only if it's valid, not reserved, and the oldest holder of that
-- name in any case.
WITH keepers AS (
    SELECT id,
           row_number() OVER (PARTITION BY lower(display_name) ORDER BY created_at, id) AS place
      FROM users
     WHERE email_normalized NOT IN ('mmbot@system.local', 'riskagent@system.local')
       AND display_name ~ '^[A-Za-z0-9_]{3,30}$'
       AND lower(display_name) NOT IN (
           'admin', 'administrator', 'anonymous', 'api', 'bot', 'challenger',
           'demo', 'help', 'market_maker', 'marketmaker', 'mmbot', 'mod',
           'moderator', 'null', 'official', 'opponent', 'playtradr', 'risk_agent',
           'riskagent', 'root', 'staff', 'support', 'system', 'trader', 'tradr',
           'undefined', 'unknown', 'you'
       )
)
UPDATE users u
   SET username_chosen_at = now()
  FROM keepers k
 WHERE u.id = k.id AND k.place = 1;

UPDATE users
   SET display_name = 'trader_' || substr(md5(gen_random_uuid()::text), 1, 10)
 WHERE username_chosen_at IS NULL;

ALTER TABLE users
    ALTER COLUMN display_name SET DEFAULT 'trader_' || substr(md5(gen_random_uuid()::text), 1, 10),
    ALTER COLUMN display_name SET NOT NULL;

ALTER TABLE users
    ADD CONSTRAINT users_display_name_format CHECK (display_name ~ '^[A-Za-z0-9_]{3,30}$');

-- One index for both jobs: case-insensitive uniqueness, and the prefix search
-- (text_pattern_ops is what lets LIKE 'abc%' use it under any collation).
CREATE UNIQUE INDEX users_display_name_lower_uq ON users (lower(display_name) text_pattern_ops);
