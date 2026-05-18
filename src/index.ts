import { app } from "./slack/app.js";
import { env } from "./config.js";
import { registerHandlers } from "./slack/handlers.js";
import { registerInteractions } from "./slack/interactions.js";

async function main() {
  registerHandlers(app);
  registerInteractions(app);
  await app.start();
  console.log(`⚡️ Bolt app running (model=${env.ANTHROPIC_MODEL})`);
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
