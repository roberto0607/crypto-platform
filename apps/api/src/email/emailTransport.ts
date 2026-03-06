import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "../observability/logContext.js";

let transporter: nodemailer.Transporter;

export function initEmailTransport() {
  if (config.smtpHost) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser ? {
        user: config.smtpUser,
        pass: config.smtpPass,
      } : undefined,
    });
  } else {
    // Development: log emails to console instead of sending
    logger.warn("No SMTP config — emails will be logged to console");
    transporter = nodemailer.createTransport({
      jsonTransport: true,  // Returns JSON instead of sending
    });
  }
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const info = await transporter.sendMail({
    from: config.emailFrom,
    to,
    subject,
    html,
  });

  if (!config.smtpHost) {
    // Development mode: log the email content
    logger.info({ to, subject, message: JSON.parse(info.message) }, "Email (dev mode, not sent)");
  } else {
    logger.info({ to, subject, messageId: info.messageId }, "Email sent");
  }
}
