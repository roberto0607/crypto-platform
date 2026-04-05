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
import v1Jobs from "./v1Jobs";
import v1Retention from "./v1Retention";
import v1Incidents from "./v1Incidents";
import v1EventStream from "./v1EventStream";
import v1Outbox from "./v1Outbox";
import v1SystemAdmin from "./v1SystemAdmin";
import v1Competitions from "./v1Competitions";
import v1Profile from "./v1Profile";
import v1Notifications from "./v1Notifications";
import v1Journal from "./v1Journal";
import v1Signals from "./v1Signals";
import v1Matches from "./v1Matches";
import v1Market from "./v1Market";

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
    await app.register(v1Jobs);
    await app.register(v1Retention);
    await app.register(v1Incidents);
    await app.register(v1EventStream);
    await app.register(v1Outbox);
    await app.register(v1SystemAdmin);
    await app.register(v1Competitions);
    await app.register(v1Profile);
    await app.register(v1Notifications);
    await app.register(v1Journal);
    await app.register(v1Signals);
    await app.register(v1Matches);
    await app.register(v1Market);
};

export default v1Routes;


