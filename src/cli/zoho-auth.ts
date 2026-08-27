import { resolve } from "node:path";
import { loadEnvFile } from "../config/load-env.js";
import { loadZohoEnv } from "../config/env.js";
import { upsertEnvValue } from "../config/write-env.js";
import { createLogger } from "../logging/logger.js";
import { parseArgs, printAuthHelp } from "./args.js";
import { ZohoOAuth } from "../integrations/zoho/oauth.js";
import { READ_ONLY_SCOPES } from "../integrations/zoho/constants.js";

loadEnvFile();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${printAuthHelp()}\n`);
    return;
  }

  const env = loadZohoEnv(process.env, { requireRefreshToken: false });
  const code = args.code ?? env.grantCode;
  if (!code) {
    throw new Error("Provide a grant token with --code or ZOHO_GRANT_CODE. See npm run zoho:auth -- --help");
  }

  const logger = createLogger();
  const oauth = new ZohoOAuth(env, logger);
  const tokens = await oauth.exchangeGrantCode(code);

  if (!tokens.refreshToken) {
    process.stdout.write(
      "Access token received, but no refresh_token was returned. Generate the grant token with access_type=offline / Self Client offline access.\n",
    );
    return;
  }

  process.stdout.write("Grant token exchanged.\n");
  process.stdout.write(`API domain: ${tokens.apiDomain}\n`);
  process.stdout.write("Add this refresh token to .env as ZOHO_REFRESH_TOKEN:\n\n");
  process.stdout.write(`${tokens.refreshToken}\n\n`);
  process.stdout.write(`Expected read-only scopes:\n${READ_ONLY_SCOPES.join(",")}\n`);

  if (args.writeEnv) {
    const envPath = resolve(process.cwd(), ".env");
    upsertEnvValue(envPath, "ZOHO_REFRESH_TOKEN", tokens.refreshToken);
    upsertEnvValue(envPath, "ZOHO_API_DOMAIN", tokens.apiDomain);
    process.stdout.write(`Wrote ZOHO_REFRESH_TOKEN and ZOHO_API_DOMAIN to ${envPath}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
