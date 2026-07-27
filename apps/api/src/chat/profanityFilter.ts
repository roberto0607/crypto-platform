/**
 * profanityFilter.ts — zero-dependency wordlist check for chat message bodies.
 *
 * Word-boundary match, case-insensitive. Deliberately basic (no leetspeak/
 * evasion handling) per the locked design — a library can replace this later
 * if coverage needs to grow.
 */

const BLOCKED_WORDS = [
    "fuck",
    "shit",
    "bitch",
    "asshole",
    "bastard",
    "cunt",
    "dick",
    "piss",
    "slut",
    "whore",
];

// \w* after the root catches common inflections (fucking, shitty, bitching)
// without matching inside unrelated words, since the leading \b still
// requires a word boundary right before the root.
const BLOCKED_PATTERN = new RegExp(
    `\\b(${BLOCKED_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\w*\\b`,
    "i",
);

export function containsProfanity(text: string): boolean {
    return BLOCKED_PATTERN.test(text);
}
