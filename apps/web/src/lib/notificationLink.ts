/** Where clicking a notification goes, for the kinds that lead somewhere. */
export function notificationLink(kind: string): string | null {
  return kind === "CHALLENGE_RECEIVED" ? "/arena" : null;
}
