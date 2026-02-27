import type { FastifyPluginAsync } from "fastify";

import v1Orders from "./v1Orders";
import v1Transactions from "./v1Transactions";
import v1Equity from "./v1Equity";
import v1Pairs from "./v1Pairs";

const v1Routes: FastifyPluginAsync = async (app) => {
    await app.register(v1Orders);
    await app.register(v1Transactions);
    await app.register(v1Equity);
    await app.register(v1Pairs);
};

export default v1Routes;
