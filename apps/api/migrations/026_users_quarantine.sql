-- Phase 9 PR5: Add QUARANTINED to account_limits.account_status
ALTER TABLE account_limits
    DROP CONSTRAINT account_limits_status_check;

ALTER TABLE account_limits
    ADD CONSTRAINT account_limits_status_check
        CHECK (account_status IN ('ACTIVE', 'SUSPENDED', 'LOCKED', 'QUARANTINED'));
