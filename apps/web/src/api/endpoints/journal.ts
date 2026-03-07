import client from "../client";

export function getJournal(params?: {
    pairId?: string;
    direction?: "LONG" | "SHORT";
    pnlSign?: "positive" | "negative";
    cursor?: string;
    limit?: number;
}) {
    return client.get("/v1/trades/journal", { params });
}

export function getJournalSummary(pairId?: string) {
    return client.get("/v1/trades/journal/summary", {
        params: pairId ? { pairId } : undefined,
    });
}

export function exportJournalCsv() {
    return client.get("/v1/trades/journal/export", {
        responseType: "blob",
    });
}
