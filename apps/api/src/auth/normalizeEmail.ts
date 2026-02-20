export function normalizeEmail(email: string): { email: string; emailNormalized: string } {
    const trimmed = email.trim();
    return {
        email: trimmed,
        emailNormalized: trimmed.toLowerCase(),
    };
}