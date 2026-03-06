import { buildApp } from "../app.js";

async function main() {
  const app = await buildApp({
    disableJobRunner: true,
    disableOutboxWorker: true,
    disableOrchestrator: true,
  });
  await app.ready();
  const spec = app.swagger();
  process.stdout.write(JSON.stringify(spec, null, 2));
  await app.close();
}

main().catch(console.error);
