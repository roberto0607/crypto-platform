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
import v1Governance from "./v1Governance";
import v1Jobs from "./v1Jobs";
import v1Retention from "./v1Retention";
import v1Reconciliation from "./v1Reconciliation";
import v1Repair from "./v1Repair";
import v1Incidents from "./v1Incidents";
import v1EventStream from "./v1EventStream";
import v1Outbox from "./v1Outbox";

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
    await app.register(v1Governance);
    await app.register(v1Jobs);
    await app.register(v1Retention);
    await app.register(v1Reconciliation);
    await app.register(v1Repair);
    await app.register(v1Incidents);
    await app.register(v1EventStream);
    await app.register(v1Outbox);
};

export default v1Routes;


