import type { FastifyRequest, FastifyReply } from "fastify";

export function requireRole(role: string) {
    return async function (req: FastifyRequest, reply: FastifyReply) {
        if(!req.user || req.user.role !== role) {
            return reply.code(403).send({ ok: false, error: "forbidden" });
        }
    };
}