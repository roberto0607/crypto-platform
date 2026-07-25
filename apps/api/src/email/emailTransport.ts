import sgMail from "@sendgrid/mail";
import { config } from "../config.js";
import { logger } from "../observability/logContext.js";

let sendGridReady = false;

export function initEmailTransport() {
  if (config.sendgridApiKey) {
    sgMail.setApiKey(config.sendgridApiKey);
    sendGridReady = true;
  } else {
    // Development: log emails to console instead of sending
    logger.warn("No SendGrid API key configured — emails will be logged to console");
    sendGridReady = false;
  }
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!sendGridReady) {
    // Development mode: log the email content instead of sending
    logger.info({ to, subject, html }, "Email (dev mode, not sent)");
    return;
  }

  const [response] = await sgMail.send({
    to,
    from: config.emailFrom,
    subject,
    html,
  });

  logger.info({ to, subject, messageId: response.headers["x-message-id"] }, "Email sent");
}
