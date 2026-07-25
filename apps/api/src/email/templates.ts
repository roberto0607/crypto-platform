import { config } from "../config.js";

export function verificationEmail(token: string): { subject: string; html: string } {
  const url = `${config.appUrl}/verify-email?token=${token}`;
  return {
    subject: "Verify your email — Crypto Platform",
    html: `
      <h2>Welcome to Crypto Platform</h2>
      <p>Click the link below to verify your email address:</p>
      <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Verify Email</a></p>
      <p>Or copy this URL: <code>${url}</code></p>
      <p>This link expires in 24 hours.</p>
      <p>If you didn't create this account, you can safely ignore this email.</p>
    `,
  };
}

const CONDITION_LABELS: Record<string, string> = {
  CROSSING: "crossed",
  CROSSING_UP: "crossed above",
  CROSSING_DOWN: "crossed below",
};

export function alertFiredEmail(
  pairSymbol: string,
  conditionType: string,
  targetValue: string,
  currentPrice: string,
  messageTemplate?: string | null,
): { subject: string; html: string } {
  const conditionLabel = CONDITION_LABELS[conditionType] ?? conditionType;
  return {
    subject: `Price alert — ${pairSymbol} ${conditionLabel} ${targetValue}`,
    html: `
      <h2>Price Alert Triggered</h2>
      <p><strong>${pairSymbol}</strong> ${conditionLabel} your target of <strong>${targetValue}</strong>.</p>
      <p>Current price: <strong>${currentPrice}</strong></p>
      ${messageTemplate ? `<p>${messageTemplate}</p>` : ""}
    `,
  };
}

export function passwordResetEmail(token: string): { subject: string; html: string } {
  const url = `${config.appUrl}/reset-password?token=${token}`;
  return {
    subject: "Reset your password — Crypto Platform",
    html: `
      <h2>Password Reset</h2>
      <p>You requested a password reset. Click the link below:</p>
      <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Reset Password</a></p>
      <p>Or copy this URL: <code>${url}</code></p>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email. Your password will not change.</p>
    `,
  };
}
