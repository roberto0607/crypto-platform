import client from "../client";

export interface PublicPlayer {
    id: string;
    username: string;
    tier: string;
    elo: number;
    wins: number;
    losses: number;
}

export function searchPlayers(q: string) {
    return client.get<{ ok: true; users: PublicPlayer[] }>("/v1/users/search", { params: { q } });
}

export function getPlayer(username: string) {
    return client.get<{ ok: true; player: PublicPlayer }>(`/v1/players/${encodeURIComponent(username)}`);
}
