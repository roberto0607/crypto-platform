import type { FastifyPluginAsync } from "fastify";
import net from "node:net";

/**
 * TEMPORARY — added 2026-07-25 to test raw TCP connectivity to
 * smtp.sendgrid.net:2525 from the production container, independent of
 * nodemailer/SMTP protocol entirely. Follow-up to the :587 probe (which
 * timed out) now that SMTP_PORT has been switched to SendGrid's alternate
 * port. Unauthenticated by necessity (pure network probe, nothing
 * sensitive), route path is a random non-guessable suffix, no other
 * diagnostic surface area. REMOVE after use.
 */
const tmpSmtpTcpDiag2525: FastifyPluginAsync = async (app) => {
  app.get("/x-802c01acbbbd57b44f67eca3", async (_req, reply) => {
    const start = Date.now();
    return new Promise((resolve) => {
      const socket = net.connect({ host: "smtp.sendgrid.net", port: 2525, timeout: 10000 });

      socket.on("connect", () => {
        const timeToConnectMs = Date.now() - start;
        socket.destroy();
        resolve(reply.send({ connected: true, timeToConnectMs }));
      });

      socket.on("timeout", () => {
        const elapsedMs = Date.now() - start;
        socket.destroy();
        resolve(reply.send({ connected: false, error: "timeout", elapsedMs }));
      });

      socket.on("error", (err) => {
        const elapsedMs = Date.now() - start;
        resolve(reply.send({ connected: false, error: err.message, elapsedMs }));
      });
    });
  });
};

export default tmpSmtpTcpDiag2525;
