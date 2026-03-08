import { pool } from "../db/pool.js";
import { weeklyCompetitionJob } from "../jobs/definitions/weeklyCompetitionJob.js";

const logger = {
    info: (...args: any[]) => console.log("[INFO]", JSON.stringify(args[0]), args[1] ?? ""),
    error: (...args: any[]) => console.error("[ERROR]", JSON.stringify(args[0]), args[1] ?? ""),
    warn: (...args: any[]) => console.warn("[WARN]", JSON.stringify(args[0]), args[1] ?? ""),
};

async function main() {
    try {
        console.log("Running weekly competition job...");
        await weeklyCompetitionJob.run({ logger } as any);
        console.log("\nCreated competitions:");

        const { rows } = await pool.query(
            `SELECT name, tier, week_id, status, start_at::text, end_at::text
             FROM competitions
             WHERE competition_type = 'WEEKLY'
             ORDER BY week_id, tier`,
        );
        console.table(rows);
    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}
main();
