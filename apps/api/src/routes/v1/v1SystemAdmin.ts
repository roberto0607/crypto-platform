import { execFile } from "node:child_process";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireUser } from "../../auth/requireUser";
import { requireRole } from "../../auth/requireRole";
import { v1HandleError } from "../../http/v1Error";
import { checkMigrationStatus } from "../../db/migrationGuard";
import { listBackups } from "../../backup/backupMetadataRepo";
import { pool } from "../../db/pool";

const SCRIPTS_DIR = path.join(process.cwd(), "scripts");

// ── Zod schemas ──

const listBackupsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ── Routes ──

const v1SystemAdmin: FastifyPluginAsync = async (app) => {
  // GET /v1/admin/system/migration-status
  app.get(
    "/admin/system/migration-status",
    { schema: { tags: ["Admin"], summary: "Check migration status", description: "Returns database migration version vs. latest code version. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { data: { type: "object", properties: { db_version: { type: "integer" }, latest_code_version: { type: "integer" }, status: { type: "string" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (_req, reply) => {
      try {
        const result = await checkMigrationStatus(pool);
        reply.send({
          data: {
            db_version: result.dbVersion,
            latest_code_version: result.latestCodeVersion,
            status: result.status,
          },
        });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // GET /v1/admin/system/backups
  app.get(
    "/admin/system/backups",
    { schema: { tags: ["Admin"], summary: "List backups", description: "Returns recent database backups. Requires ADMIN role.", security: [{ bearerAuth: [] }], querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } } }, response: { 200: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (req, reply) => {
      try {
        const query = listBackupsQuery.parse(req.query);
        const backups = await listBackups(query.limit);
        reply.send({ data: backups });
      } catch (err) {
        return v1HandleError(reply, err);
      }
    },
  );

  // POST /v1/admin/system/restore-drill
  // Always returns 200 — result field carries PASS or FAIL.
  app.post(
    "/admin/system/restore-drill",
    { schema: { tags: ["Admin"], summary: "Run restore drill", description: "Runs a backup-restore drill to verify backup integrity. Always returns 200 — result field carries PASS or FAIL. Requires ADMIN role.", security: [{ bearerAuth: [] }], response: { 200: { type: "object", properties: { data: { type: "object", properties: { result: { type: "string", enum: ["PASS", "FAIL"] }, output: { type: "string" }, message: { type: "string" } } } } } } }, preHandler: [requireUser, requireRole("ADMIN")] },
    async (_req, reply) => {
      try {
        const scriptPath = path.join(SCRIPTS_DIR, "restore-drill.sh");
        const env = {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? "",
          BACKUP_DIR: process.env.BACKUP_DIR ?? "./backups",
          DRILL_DB_NAME: process.env.RESTORE_DB_NAME ?? "cp_restore_test",
        };

        const output = await new Promise<string>((resolve, reject) => {
          execFile(
            "bash",
            [scriptPath],
            { env, timeout: 300_000 },
            (err, stdout, stderr) => {
              if (err) {
                reject(new Error(`${stdout}\n${stderr}`.trim()));
              } else {
                resolve(stdout);
              }
            },
          );
        });

        reply.send({ data: { result: "PASS", output } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.status(200).send({ data: { result: "FAIL", message } });
      }
    },
  );
};

export default v1SystemAdmin;
