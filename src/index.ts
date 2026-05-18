import { app } from "./slack/app.js";
import { env } from "./config.js";
import { registerHandlers } from "./slack/handlers.js";
import { registerInteractions } from "./slack/interactions.js";
import { detectAuth, describeAuth } from "./auth.js";

async function main() {
  const auth = detectAuth();
  if (auth.kind === "none") {
    console.error(
      "❌ No Claude auth configured.\n" +
        "   Either set ANTHROPIC_API_KEY in .env, or authenticate your Claude\n" +
        "   subscription account by running:  npm run login",
    );
    process.exit(1);
  }
  console.log(`🔐 Claude auth: ${describeAuth(auth)}`);

  registerHandlers(app);
  registerInteractions(app);
  await app.start();
  console.log(`⚡️ Bolt app running (model=${env.ANTHROPIC_MODEL})`);
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
