import client from "../client";

export function getProfile() {
    return client.get<{
        ok: true;
        profile: {
            id: string;
            email: string;
            displayName: string | null;
            role: string;
        };
    }>("/v1/profile");
}

export function updateDisplayName(displayName: string) {
    return client.patch<{ ok: true; displayName: string }>("/v1/profile", {
        displayName,
    });
}
