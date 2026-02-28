import type { FastifyPluginAsync } from "fastify";

import v1Orders from "./v1Orders";
import v1Transactions from "./v1Transactions";
import v1Equity from "./v1Equity";
import v1Pairs from "./v1Pairs";
import v1Events from "./v1Events";
import v1Triggers from "./v1Triggers";
import v1Bot from "./v1Bot";
import v1Portfolio from "./v1Portfolio";
import v1Sim from "./v1Sim";

const v1Routes: FastifyPluginAsync = async (app) => {
    await app.register(v1Orders);
    await app.register(v1Transactions);
    await app.register(v1Equity);
    await app.register(v1Pairs);
    await app.register(v1Events);
    await app.register(v1Triggers);
    await app.register(v1Bot);
    await app.register(v1Portfolio);
    await app.register(v1Sim);
};

export default v1Routes;

