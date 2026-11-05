/**
 * Create or close a season. Dry run unless --apply is given.
 *
 *   pnpm season:create --name "Season 1" --days 28 [--start <ISO>] [--apply]
 *   pnpm season:close --id <uuid> [--cancel] [--apply]
 *
 * See docs/runbooks/seasons.md.
 */
import "dotenv/config";
import { pool } from "../db/pool";
import { closeSeason, createSeason } from "../competitions/seasonService";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const flag = (name: string) => process.argv.includes(`--${name}`);

async function create(apply: boolean): Promise<void> {
    const start = arg("start");
    const plan = await createSeason({
        name: arg("name") ?? "",
        days: Number(arg("days") ?? 28),
        ...(start ? { start: new Date(start) } : {}),
    }, { apply });
    console.log(`Season ${plan.seasonNumber}: ${plan.name}`);
    console.log(`  starts      ${plan.startAt.toISOString()}`);
    console.log(`  ends        ${plan.endAt.toISOString()}`);
    console.log(`  off-season  until ${plan.offSeasonEndsAt.toISOString()}`);
}

async function close(apply: boolean): Promise<void> {
    const plan = await closeSeason(arg("id") ?? "", { apply, cancel: flag("cancel") });
    console.log(plan.action === "cancel"
        ? `Cancel ${plan.name} (${plan.status}): no ranks, no badges.`
        : `Close ${plan.name} (${plan.status}): end_at moves to now, and the lifecycle job ends it within a minute.`);
}

async function main(): Promise<void> {
    const command = process.argv[2];
    const apply = flag("apply");
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
    console.log(`${apply ? "APPLY" : "DRY RUN"} on ${host}`);

    if (command === "create") await create(apply);
    else if (command === "close") await close(apply);
    else throw new Error("Use: season.ts create|close");

    console.log(apply ? "Done." : "Nothing changed. Add --apply to do this.");
}

main()
    .catch((err) => {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
