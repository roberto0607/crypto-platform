import type { FastifyPluginAsync } from "fastify";
import net from "node:net";

/**
 * TEMPORARY — added 2026-07-25 to test raw TCP connectivity to
 * smtp.sendgrid.net:587 from the production container, independent of
 * nodemailer/SMTP protocol entirely. Unauthenticated by necessity (this is
 * a pure network probe, nothing sensitive), route path is a random
 * non-guessable suffix, no other diagnostic surface area. REMOVE after use.
 */
const tmpSmtpTcpDiag: FastifyPluginAsync = async (app) => {
  app.get("/x-af9e3efbed201fd94d191427", async (_req, reply) => {
    const start = Date.now();
    return new Promise((resolve) => {
      const socket = net.connect({ host: "smtp.sendgrid.net", port: 587, timeout: 10000 });

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

export default tmpSmtpTcpDiag;
