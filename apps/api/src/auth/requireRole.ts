import type { FastifyRequest, FastifyReply } from "fastify";

export function requireRole(role: string) {
    return async function (req: FastifyRequest, reply: FastifyReply) {
        const user = (req as any).user;

        if(!user || user.role !== role) {
            return reply.code(403).send({ ok: false, error: "forbidden" });
        }
    };
}