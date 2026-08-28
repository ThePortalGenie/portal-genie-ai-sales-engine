import assert from "node:assert/strict";
import test from "node:test";
import { ZohoOAuth } from "../src/integrations/zoho/oauth.js";
import { ZohoAuthError } from "../src/integrations/zoho/errors.js";
import { createLogger } from "../src/logging/logger.js";
import type { ZohoEnv } from "../src/config/env.js";

const env: ZohoEnv = {
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh-token",
  accountsUrl: "https://accounts.zoho.eu",
  redirectUri: "http://localhost",
};

test("refreshAccessToken posts form data to the accounts token endpoint", async () => {
  let postedUrl = "";
  let postedBody = "";
  const oauth = new ZohoOAuth(
    env,
    createLogger({ level: "error" }),
    (async (input, init) => {
      postedUrl = String(input);
      postedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "access",
          api_domain: "https://www.zohoapis.eu",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  );

  const tokens = await oauth.refreshAccessToken();
  assert.equal(postedUrl, "https://accounts.zoho.eu/oauth/v2/token");
  assert.match(postedBody, /grant_type=refresh_token/);
  assert.match(postedBody, /refresh_token=refresh-token/);
  assert.equal(tokens.apiDomain, "https://www.zohoapis.eu");
  assert.equal(await oauth.getApiDomain(), "https://www.zohoapis.eu");
});

test("exchangeGrantCode requires access_token and api_domain", async () => {
  const oauth = new ZohoOAuth(
    env,
    createLogger({ level: "error" }),
    (async () =>
      new Response(JSON.stringify({ error: "invalid_code" }), { status: 400 })) as typeof fetch,
  );
  await assert.rejects(() => oauth.exchangeGrantCode("bad"), ZohoAuthError);
});

test("authorizationUrl does not include the client secret", () => {
  const oauth = new ZohoOAuth(env, createLogger({ level: "error" }));
  const url = oauth.authorizationUrl("state-1");
  assert.match(url, /accounts\.zoho\.eu\/oauth\/v2\/auth/);
  assert.doesNotMatch(url, /secret/);
  assert.match(url, /state=state-1/);
});

test("concurrent getAccessToken refreshes once", async () => {
  let posts = 0;
  const oauth = new ZohoOAuth(
    env,
    createLogger({ level: "error" }),
    (async () => {
      posts += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(
        JSON.stringify({
          access_token: "access",
          api_domain: "https://www.zohoapis.eu",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  );
  const [left, right] = await Promise.all([oauth.getAccessToken(), oauth.getAccessToken()]);
  assert.equal(left, "access");
  assert.equal(right, "access");
  assert.equal(posts, 1);
});
