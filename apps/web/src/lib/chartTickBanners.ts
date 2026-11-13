/**
 * The chart's alert banners, decided per price tick (and on each overlay
 * render): PDH/PDL proximity and the S/R APPROACHING banner. Pure so the
 * tick handler and the overlay pass share one rule, and so a tick that
 * doesn't change a banner keeps the previous value (React skips the render).
 */
import { srApproach, type SRBanner, type SRDrawable } from "@/lib/srDisplay";

/** Within this % of the price, a previous-day/week high or low raises the APPROACHING badge. */
export const KEY_LEVEL_PROXIMITY_PCT = 1.5;

export type KeyLevelBanner = "pdh" | "pdl" | null;

export interface KeyLevelProximity {
    pdhProx: boolean;
    pdlProx: boolean;
    /** The badge shown: the high wins when both are near. */
    banner: KeyLevelBanner;
}

export function keyLevelProximity(levels: { pdh: number; pdl: number }, price: number): KeyLevelProximity {
    const pdhProx = price > 0 && (Math.abs(levels.pdh - price) / price) * 100 <= KEY_LEVEL_PROXIMITY_PCT;
    const pdlProx = price > 0 && (Math.abs(price - levels.pdl) / price) * 100 <= KEY_LEVEL_PROXIMITY_PCT;
    return { pdhProx, pdlProx, banner: pdhProx ? "pdh" : pdlProx ? "pdl" : null };
}

export function sameBanner(a: SRBanner | null, b: SRBanner | null): boolean {
    return a === b || (!!a && !!b && a.role === b.role && a.price === b.price && a.label === b.label);
}

/** `prev` when the banner is unchanged (same object → no re-render), else the new one. */
export function keepBanner(prev: SRBanner | null, next: SRBanner | null): SRBanner | null {
    return sameBanner(prev, next) ? prev : next;
}

/** The S/R APPROACHING banner at `price`, keeping `prev` when it's the same level. */
export function nextSrApproach(prev: SRBanner | null, drawables: SRDrawable[], price: number, atr: number): SRBanner | null {
    return keepBanner(prev, srApproach(drawables, price, atr));
}
