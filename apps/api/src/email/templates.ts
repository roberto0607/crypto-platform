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
