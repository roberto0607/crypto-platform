import type { FastifyPluginAsync } from "fastify";
import { getDisplaySeason } from "../../competitions/seasonService";
import { v1HandleError } from "../../http/v1Error";

const v1Seasons: FastifyPluginAsync = async (app) => {
    // GET /v1/seasons/current — the season the Arena shows. Public, like the leaderboard.
    app.get("/seasons/current", {
        schema: {
            tags: ["Competitions"],
            summary: "Current season",
            description: "The active season, else the last season during its off-season (status ENDED), else null.",
        },
    }, async (_req, reply) => {
        try {
            return reply.send({ ok: true, season: await getDisplaySeason() });
        } catch (err) {
            return v1HandleError(reply, err);
        }
    });
};

export default v1Seasons;
