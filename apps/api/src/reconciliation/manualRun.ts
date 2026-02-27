import { runFullReconciliation } from "./reconciliationService";
import { pool } from "../db/pool";

async function main() {
  try {
    const report = await runFullReconciliation();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.overallStatus === "OK" ? 0 : 1;
  } catch (err) {
    console.error("Reconciliation failed:", err);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main();
