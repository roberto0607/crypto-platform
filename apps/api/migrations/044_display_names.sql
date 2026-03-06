-- Phase 14 PR4: Display names for users
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
