import type { FastifyRequest, FastifyReply } from "fastify";

type JwtPayload = {
    sub?: string; // user id (string)
    role?: string; // "USER" | "ADMIN" etc
};

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
    try{
        const payload = (await req.jwtVerify()) as JwtPayload;

        req.user = {
            id: payload.sub!,
            role: payload.role ?? "USER",
        };
    }catch{
        return reply.code(401).send({ ok: false, error: "unauthorized" })
    }
}
