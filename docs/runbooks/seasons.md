# Seasons

Run from `apps/api` with `DATABASE_URL` set. Every command is a dry run until you add `--apply`, and it prints which host it targets.

Migration 105 must be deployed first.

## Start a season
```
pnpm season:create --name "Season 1" --days 28 [--start <ISO>]
pnpm season:create --name "Season 1" --days 28 --apply
```
The start defaults to now. The lifecycle job makes it ACTIVE within a minute. Only one season can be open.

## End one early
```
pnpm season:close --id <uuid> --apply
```
This moves `end_at` to now. The lifecycle job then writes the final board, awards badges and notifies players within a minute. A season past its `end_at` ends the same way by itself.

## Drop a mistake
```
pnpm season:close --id <uuid> --cancel --apply
```
No ranks, no badges. Works on UPCOMING and ACTIVE seasons.

## Turning on ELO_INTEGRITY_ENABLED
Migration 107 must be deployed first. Cancel the current season, set `ELO_INTEGRITY_ENABLED=true` on `crypto-platform`, then start a fresh one:
```
pnpm season:close --id <season 1 uuid> --cancel --apply
# set ELO_INTEGRITY_ENABLED=true on crypto-platform and let it redeploy
pnpm season:create --name "Season 2" --days 28 --apply
```
Cancel first: with the flag on, the board is built only from points stored for matches resolved with the flag on, so an open Season 1 would rebuild to near empty. The rules apply only to matches resolved after the flip; no past match, ELO or score is recomputed.

## Rules
With `ELO_INTEGRITY_ENABLED` on (see `apps/api/src/competitions/eloIntegrity.ts`):
- SCORE is the season points stored when each match was resolved: the ELO change with the win streak counted from the season start, times 100% / 50% / 25% for a player's 1st–3rd / 4th–6th / 7th+ match against that opponent in the season.
- A winner whose gain was blocked (early forfeit, either player under 1 fill or 10% of starting capital traded, or the pair's 3rd+ match in 24h) is unrated: the match doesn't count for them. The loser's match always counts.

With it off:
- SCORE is ELO gained in matches finished inside the window. Only a player's first 3 matches against each opponent count toward it. A match still running at the end doesn't count.
- Ties: win rate, then who reached the score first.
- Badges go to the top 10 players with 3+ matches: `SEASON_CHAMPION` for the first, `SEASON_TOP_10` for the rest. An unqualified player can still rank above them.
- ELO, tiers and records don't reset. The Arena shows final standings for 3 days, then "NO ACTIVE SEASON".
