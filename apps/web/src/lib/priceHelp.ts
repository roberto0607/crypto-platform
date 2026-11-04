/** One line per price the trade page shows: they come from different places (audit F-02). */
export const PRICE_HELP = {
  last: "Last: the most recent trade on Coinbase. The chart's headline price; orders don't fill here.",
  mark: "Mark: the Kraken book mid. P&L, margin health and liquidation on leveraged positions use it.",
  bidAsk: "Bid / Ask: the best prices in the Kraken book. A market buy starts at the ask, a market sell at the bid.",
  estFill: "Est. fill: the average price this order would get right now, walking the book from the bid or ask for its size.",
} as const;
