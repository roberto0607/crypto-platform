import { D, toFixed8 } from "../utils/decimal";
import type { SimulationConfig } from "./simTypes";

const LIQUIDITY_FACTOR = D("0.1");

export function computeAvailableLiquidity(
    config: SimulationConfig,
    candleVolume: string | null,
    snapshotLast: string
): string {
    const maxPerTick = D(config.liquidity_quote_per_tick);

    if (!candleVolume || D(candleVolume).isZero()) {
        return toFixed8(maxPerTick);
    }

    const volumeBased = D(candleVolume).mul(D(snapshotLast)).mul(LIQUIDITY_FACTOR);
    return toFixed8(maxPerTick.lt(volumeBased) ? maxPerTick : volumeBased);
}
