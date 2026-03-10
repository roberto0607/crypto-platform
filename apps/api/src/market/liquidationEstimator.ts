export interface LiquidationLevel {
    price: number;
    magnitude: number;     // estimated USD volume at risk
    leverage: number;       // 5x, 10x, 25x, 50x, 100x
    side: "long" | "short"; // which side gets liquidated at this price
}

/**
 * Common leverage tiers and their estimated usage distribution.
 * Based on typical crypto exchange leverage patterns.
 */
const LEVERAGE_TIERS = [
    { leverage: 5, weight: 0.10 },
    { leverage: 10, weight: 0.25 },
    { leverage: 25, weight: 0.35 },
    { leverage: 50, weight: 0.20 },
    { leverage: 100, weight: 0.10 },
];

/**
 * Estimate liquidation levels based on current price and open interest.
 *
 * For each leverage tier:
 * - Long liquidation price = currentPrice * (1 - 1/leverage)
 * - Short liquidation price = currentPrice * (1 + 1/leverage)
 *
 * Magnitude = openInterest * weight (proportion of OI estimated at each leverage)
 */
export function estimateLiquidationLevels(
    currentPrice: number,
    openInterest: number,
): LiquidationLevel[] {
    if (currentPrice <= 0 || openInterest <= 0) return [];

    const levels: LiquidationLevel[] = [];

    for (const tier of LEVERAGE_TIERS) {
        const magnitude = openInterest * tier.weight;

        // Long liquidation: price drops to this level
        levels.push({
            price: currentPrice * (1 - 1 / tier.leverage),
            magnitude,
            leverage: tier.leverage,
            side: "long",
        });

        // Short liquidation: price rises to this level
        levels.push({
            price: currentPrice * (1 + 1 / tier.leverage),
            magnitude,
            leverage: tier.leverage,
            side: "short",
        });
    }

    // Sort by distance from current price (closest first)
    levels.sort((a, b) =>
        Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice),
    );

    return levels;
}
