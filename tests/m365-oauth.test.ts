import assert from "node:assert/strict";
import test from "node:test";
import { M365OAuth } from "../src/integrations/m365/oauth.js";
import { M365AuthError } from "../src/integrations/m365/errors.js";
import {
  FORBIDDEN_GRAPH_SCOPES,
  READ_ONLY_DELEGATED_SCOPES,
  assertReadOnlyScopes,
  scopeListForOAuth,
} from "../src/integrations/m365/constants.js";
import { createLogger } from "../src/logging/logger.js";
import type { M365Env } from "../src/config/m365.js";

const env: M365Env = {
  clientId: "client-id",
  clientSecret: "client-secret",
  tenantId: "tenant-guid",
  redirectUri: "http://127.0.0.1:8787/api/m365/oauth/callback",
};

test("read-only scopes exclude Mail.Send and write scopes", () => {
  for (const forbidden of FORBIDDEN_GRAPH_SCOPES) {
    assert.equal(READ_ONLY_DELEGATED_SCOPES.includes(forbidden as never), false);
    assert.throws(() => assertReadOnlyScopes([forbidden]), /Forbidden Microsoft Graph scope/);
  }
  assert.match(scopeListForOAuth(), /Mail\.Read/);
  assert.doesNotMatch(scopeListForOAuth(), /Mail\.Send/);
});

test("authorizationUrl uses delegated read-only scopes and does not include client secret", () => {
  const oauth = new M365OAuth(env, createLogger({ level: "error" }));
  const url = oauth.authorizationUrl("portal-genie-primary:state-1");
  assert.match(url, /login\.microsoftonline\.com\/tenant-guid\/oauth2\/v2\.0\/authorize/);
  assert.match(url, /scope=.*Mail\.Read/);
  assert.doesNotMatch(url, /Mail\.Send/);
  assert.doesNotMatch(url, /client-secret|client_secret/i);
  assert.match(url, /state=portal-genie-primary%3Astate-1/);
});

test("exchangeAuthorizationCode posts to tenant token endpoint", async () => {
  let postedUrl = "";
  let postedBody = "";
  const oauth = new M365OAuth(
    env,
    createLogger({ level: "error" }),
    (async (input, init) => {
      postedUrl = String(input);
      postedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: scopeListForOAuth(),
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  );

  const tokens = await oauth.exchangeAuthorizationCode("auth-code");
  assert.match(postedUrl, /oauth2\/v2\.0\/token/);
  assert.match(postedBody, /grant_type=authorization_code/);
  assert.match(postedBody, /code=auth-code/);
  assert.equal(tokens.refreshToken, "refresh");
  assert.equal(await oauth.getAccessToken(), "access");
});

test("exchangeAuthorizationCode requires access_token", async () => {
  const oauth = new M365OAuth(
    env,
    createLogger({ level: "error" }),
    (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch,
  );
  await assert.rejects(() => oauth.exchangeAuthorizationCode("bad"), M365AuthError);
});

test("refreshAccessToken requires stored refresh token", async () => {
  const oauth = new M365OAuth(env, createLogger({ level: "error" }));
  await assert.rejects(() => oauth.refreshAccessToken(), M365AuthError);
});
