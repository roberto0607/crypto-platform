/**
 * btcCycles.ts — VETTED static Bitcoin cycle-history dataset for the Cycles tab.
 *
 * RISK-EDUCATION REFERENCE ONLY. No live API, no forecasting. The only live value
 * in the Cycles tab is the current BTC price (read from pairPricesStore), used for
 * the "you are here" marker and current drawdown — it is NOT in this file.
 *
 * Provenance (sourced & cross-verified June 2026):
 *  - Monthly close line: daily-close history (Habrador/Bitcoin-price-visualization,
 *    2010-07 → 2026-04), downsampled to last close per calendar month; May 2026
 *    close (~73,100) from contemporaneous reporting. These are CLOSES, so the line
 *    sits just under the intraday wick highs below (that's expected).
 *  - Cycle tops/bottoms + ATH: canonical INTRADAY extremes (the numbers traders cite).
 *  - Drawdown% and daysUnderwater computed from the above; peak-to-trough days for
 *    cycles 1 & 2 (163 / 410) independently match prior hand-checks.
 *  - Halving #4 dated 2024-04-20 (UTC, block 840,000 @ 00:09:27Z); shows as Apr 19 in US time.
 */

export interface BtcCycle {
  n: number;
  topPrice: number;   topDate: string;   // intraday peak
  bottomPrice: number; bottomDate: string; // intraday trough
  drawdownPct: number;        // peak -> trough
  daysUnderwater: number;     // top date -> first close back above topPrice
  reclaimDate: string;
}

export interface BtcHalving {
  date: string; label: string; fromReward: number; toReward: number;
}

// ── The lesson: tops round-trip 77–94%, and stay underwater 21–39 months ──
export const BTC_CYCLES: BtcCycle[] = [
  { n: 1, topPrice: 31.91,  topDate: "2011-06-08", bottomPrice: 2,     bottomDate: "2011-11-18", drawdownPct: -94, daysUnderwater: 631,  reclaimDate: "2013-02-28" },
  { n: 2, topPrice: 1163,   topDate: "2013-11-30", bottomPrice: 164,   bottomDate: "2015-01-14", drawdownPct: -86, daysUnderwater: 1181, reclaimDate: "2017-02-23" },
  { n: 3, topPrice: 19783,  topDate: "2017-12-17", bottomPrice: 3200,  bottomDate: "2018-12-15", drawdownPct: -84, daysUnderwater: 1096, reclaimDate: "2020-12-17" },
  { n: 4, topPrice: 69000,  topDate: "2021-11-10", bottomPrice: 15500, bottomDate: "2022-11-21", drawdownPct: -77, daysUnderwater: 851,  reclaimDate: "2024-03-10" },
];

export const BTC_ATH = { price: 126210, date: "2025-10-06" } as const;

export const BTC_HALVINGS: BtcHalving[] = [
  { date: "2012-11-28", label: "Halving 1", fromReward: 50,    toReward: 25 },
  { date: "2016-07-09", label: "Halving 2", fromReward: 25,    toReward: 12.5 },
  { date: "2020-05-11", label: "Halving 3", fromReward: 12.5,  toReward: 6.25 },
  { date: "2024-04-20", label: "Halving 4", fromReward: 6.25,  toReward: 3.125 },
];

/**
 * Observed rhythm (NOT a law): each ATH has landed ~12–18 months after a halving
 * (2013, 2017, 2021 tops all Nov–Dec). Four data points — present as pattern, not prediction.
 */

// Monthly CLOSE, ["YYYY-MM", usd]. 2010-07 → 2026-05 (last complete month). 191 points.
export const BTC_MONTHLY_CLOSE: ReadonlyArray<readonly [string, number]> = [["2010-07",0.07], ["2010-08",0.06], ["2010-09",0.06], ["2010-10",0.19], ["2010-11",0.21], ["2010-12",0.3], ["2011-01",0.52], ["2011-02",0.86], ["2011-03",0.78], ["2011-04",3.5], ["2011-05",8.74], ["2011-06",16.1], ["2011-07",13.3], ["2011-08",8.2], ["2011-09",5.14], ["2011-10",3.25], ["2011-11",2.97], ["2011-12",4.72], ["2012-01",5.48], ["2012-02",4.86], ["2012-03",4.91], ["2012-04",4.95], ["2012-05",5.18], ["2012-06",6.69], ["2012-07",9.35], ["2012-08",10.2], ["2012-09",12.4], ["2012-10",11.2], ["2012-11",12.6], ["2012-12",13.5], ["2013-01",20.4], ["2013-02",33.4], ["2013-03",93], ["2013-04",139], ["2013-05",129], ["2013-06",97.5], ["2013-07",97.9], ["2013-08",129], ["2013-09",123], ["2013-10",198], ["2013-11",1125], ["2013-12",758], ["2014-01",848], ["2014-02",544], ["2014-03",458], ["2014-04",446], ["2014-05",623], ["2014-06",639], ["2014-07",581], ["2014-08",478], ["2014-09",386], ["2014-10",337], ["2014-11",377], ["2014-12",320], ["2015-01",217], ["2015-02",254], ["2015-03",243], ["2015-04",237], ["2015-05",230], ["2015-06",262], ["2015-07",284], ["2015-08",230], ["2015-09",236], ["2015-10",312], ["2015-11",377], ["2015-12",430], ["2016-01",367], ["2016-02",437], ["2016-03",415], ["2016-04",449], ["2016-05",532], ["2016-06",672], ["2016-07",626], ["2016-08",572], ["2016-09",608], ["2016-10",697], ["2016-11",742], ["2016-12",968], ["2017-01",968], ["2017-02",1191], ["2017-03",1080], ["2017-04",1348], ["2017-05",2330], ["2017-06",2500], ["2017-07",2874], ["2017-08",4765], ["2017-09",4353], ["2017-10",6448], ["2017-11",9917], ["2017-12",13900], ["2018-01",10200], ["2018-02",10300], ["2018-03",6926], ["2018-04",9244], ["2018-05",7487], ["2018-06",6387], ["2018-07",7727], ["2018-08",6984], ["2018-09",6599], ["2018-10",6289], ["2018-11",4242], ["2018-12",3690], ["2019-01",3421], ["2019-02",3800], ["2019-03",4095], ["2019-04",5277], ["2019-05",8513], ["2019-06",10900], ["2019-07",10000], ["2019-08",9625], ["2019-09",8241], ["2019-10",9226], ["2019-11",7729], ["2019-12",7251], ["2020-01",9545], ["2020-02",8778], ["2020-03",6484], ["2020-04",8773], ["2020-05",9688], ["2020-06",9188], ["2020-07",11100], ["2020-08",11700], ["2020-09",10800], ["2020-10",13600], ["2020-11",18100], ["2020-12",28800], ["2021-01",34600], ["2021-02",46600], ["2021-03",58700], ["2021-04",53300], ["2021-05",35700], ["2021-06",35900], ["2021-07",41200], ["2021-08",47700], ["2021-09",41400], ["2021-10",61300], ["2021-11",57800], ["2021-12",47100], ["2022-01",37900], ["2022-02",43200], ["2022-03",45500], ["2022-04",37700], ["2022-05",31800], ["2022-06",19800], ["2022-07",23300], ["2022-08",20000], ["2022-09",19400], ["2022-10",20500], ["2022-11",17200], ["2022-12",16500], ["2023-01",23100], ["2023-02",23100], ["2023-03",28500], ["2023-04",29300], ["2023-05",27200], ["2023-06",30500], ["2023-07",29200], ["2023-08",25900], ["2023-09",27000], ["2023-10",34700], ["2023-11",37700], ["2023-12",42300], ["2024-01",42600], ["2024-02",61200], ["2024-03",71300], ["2024-04",60600], ["2024-05",67500], ["2024-06",62700], ["2024-07",64600], ["2024-08",59200], ["2024-09",63500], ["2024-10",70300], ["2024-11",96500], ["2024-12",93800], ["2025-01",102500], ["2025-02",84700], ["2025-03",82700], ["2025-04",94300], ["2025-05",104700], ["2025-06",107200], ["2025-07",116000], ["2025-08",108400], ["2025-09",114000], ["2025-10",109800], ["2025-11",90400], ["2025-12",87700], ["2026-01",78800], ["2026-02",67000], ["2026-03",68300], ["2026-04",76400], ["2026-05",73100]];
