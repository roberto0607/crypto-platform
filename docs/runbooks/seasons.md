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

## Rules
- SCORE is ELO gained in matches finished inside the window. Only a player's first 3 matches against each opponent count toward it. A match still running at the end doesn't count.
- Ties: win rate, then who reached the score first.
- Badges go to the top 10 players with 3+ matches: `SEASON_CHAMPION` for the first, `SEASON_TOP_10` for the rest. An unqualified player can still rank above them.
- ELO, tiers and records don't reset. The Arena shows final standings for 3 days, then "NO ACTIVE SEASON".
