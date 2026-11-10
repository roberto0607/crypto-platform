/**
 * Regenerates fixtures/golden.json from the shared source. Run only for an
 * intended math change, and say in the PR which values moved:
 *
 *   apps/api/node_modules/.bin/tsx packages/indicators/scripts/genGolden.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeParitySeries, fingerprint, fixtureCandles, toGolden,
  PARITY_TIMEFRAME_SEC, type CandleFixture,
} from "../src/index";

const dir = new URL("../fixtures/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("btcusd-coinbase.json", dir), "utf8")) as CandleFixture;

const lines = ["{"];
const tfs = Object.keys(PARITY_TIMEFRAME_SEC);
tfs.forEach((tf, ti) => {
  const golden = toGolden(fingerprint(computeParitySeries(fixtureCandles(fixture.timeframes[tf]!), PARITY_TIMEFRAME_SEC[tf]!)));
  const names = Object.keys(golden);
  lines.push(`  "${tf}": {`);
  names.forEach((name, ni) => lines.push(`    "${name}": ${JSON.stringify(golden[name])}${ni < names.length - 1 ? "," : ""}`));
  lines.push(`  }${ti < tfs.length - 1 ? "," : ""}`);
});
lines.push("}", "");
writeFileSync(fileURLToPath(new URL("golden.json", dir)), lines.join("\n"));
console.log(`wrote golden for ${tfs.join(", ")}`);
