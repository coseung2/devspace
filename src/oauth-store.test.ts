import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { databasePath, openDatabase } from "./db/client.js";
import { migrateDatabase, OWNER_CALLER_KEY } from "./db/migrations.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));
const oauthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const rocheExtensionId = "gefkajhiepdopchmhaliiecdmfohgbce";
const rocheRedirectHost = `${rocheExtensionId}.chromiumapp.org`;

try {
  await testDatabaseConfiguration(join(root, "database-configuration"));
  testOwnerCallerKeyMigration(join(root, "owner-caller-key"));
  testPersistenceAndTokenHashing(join(root, "persistence"));
  testRedirectHostAllowlist(join(root, "redirect-hosts"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testTransactionalTokenRotation(join(root, "rotation"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDatabaseConfiguration(stateDir: string): Promise<void> {
  const database = openDatabase(stateDir);
  try {
    assert.equal(database.sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.sqlite.pragma("synchronous", { simple: true }), 1);
    assert.equal(database.sqlite.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(database.sqlite.pragma("foreign_keys", { simple: true }), 1);

    const migrations = database.sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all();
    assert.deepEqual(migrations, [
      { version: 1, name: "workspace-state" },
      { version: 2, name: "oauth-state" },
      { version: 3, name: "local-agent-sessions" },
      { version: 4, name: "workspace-conversation-bindings" },
      { version: 5, name: "mcp-tasks" },
      { version: 6, name: "mcp-task-approval" },
      { version: 7, name: "mcp-task-owner-caller-key" },
    ]);
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(databasePath(stateDir))).mode & 0o777, 0o600);
  }
}

/**
 * Legacy task rows were owned by a per-OAuth-client caller key, so a task
 * created by the ChatGPT client was invisible to any other authorized client.
 * Re-running the migration on a database that still holds legacy rows must
 * re-key them to the single owner caller key without touching any other field.
 */
function testOwnerCallerKeyMigration(stateDir: string): void {
  const legacyRow = {
    task_id: "task_legacy_client_scoped",
    caller_key: "devspace-11111111-2222-3333-4444-555555555555",
    operation: "worker.spawn",
    workspace_id: "ws_legacy",
    agent_id: null,
    process_session_id: 7,
    status: "input_required",
    status_message: "Review and approval required.",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:01.000Z",
    poll_interval_ms: 1000,
    ttl_ms: 86_400_000,
    input_requests_json: JSON.stringify(["approve"]),
    result_json: JSON.stringify({ content: [{ type: "text", text: "LEGACY_TASK_OUTPUT" }] }),
    error: null,
    cancel_requested: 0,
    approval_required: 1,
  };

  const seeded = openDatabase(stateDir);
  try {
    seeded.sqlite
      .prepare(`
        insert into mcp_tasks (
          task_id, caller_key, operation, workspace_id, agent_id, process_session_id,
          status, status_message, created_at, updated_at, poll_interval_ms, ttl_ms,
          input_requests_json, result_json, error, cancel_requested, approval_required
        ) values (
          @task_id, @caller_key, @operation, @workspace_id, @agent_id, @process_session_id,
          @status, @status_message, @created_at, @updated_at, @poll_interval_ms, @ttl_ms,
          @input_requests_json, @result_json, @error, @cancel_requested, @approval_required
        )
      `)
      .run(legacyRow);
    // Reproduce a database written before the owner-key migration existed.
    seeded.sqlite.prepare("delete from devspace_schema_migrations where version = 7").run();
    assert.equal(
      seeded.sqlite.prepare("select caller_key from mcp_tasks where task_id = ?").pluck().get(legacyRow.task_id),
      legacyRow.caller_key,
    );
  } finally {
    seeded.close();
  }

  const migrated = openDatabase(stateDir);
  try {
    const row = migrated.sqlite
      .prepare("select * from mcp_tasks where task_id = ?")
      .get(legacyRow.task_id) as typeof legacyRow;
    assert.deepEqual(row, { ...legacyRow, caller_key: OWNER_CALLER_KEY });
    assert.equal(migrated.sqlite.prepare("select count(*) from mcp_tasks").pluck().get(), 1);

    // The migration is idempotent and leaves already-owned rows untouched.
    migrateDatabase(migrated.sqlite);
    assert.deepEqual(
      migrated.sqlite.prepare("select * from mcp_tasks where task_id = ?").get(legacyRow.task_id),
      { ...legacyRow, caller_key: OWNER_CALLER_KEY },
    );
  } finally {
    migrated.close();
  }
}

function testPersistenceAndTokenHashing(stateDir: string): void {
  const accessToken = "access-token-example";
  const refreshToken = "refresh-token-example";
  const firstStore = new SqliteOAuthStore(stateDir);
  const firstClients = new SqliteOAuthClientsStore(firstStore, oauthConfig.allowedRedirectHosts);
  const client = firstClients.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });

  firstStore.saveTokenPair({
    accessTokenHash: hashToken(accessToken),
    accessToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl.href,
    },
    refreshTokenHash: hashToken(refreshToken),
    refreshToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      resource: mcpUrl.href,
    },
  });
  firstStore.close();

  const database = openDatabase(stateDir);
  try {
    const accessHashes = database.sqlite
      .prepare("select token_hash from oauth_access_tokens")
      .pluck()
      .all() as string[];
    const refreshHashes = database.sqlite
      .prepare("select token_hash from oauth_refresh_tokens")
      .pluck()
      .all() as string[];
    assert.deepEqual(accessHashes, [hashToken(accessToken)]);
    assert.deepEqual(refreshHashes, [hashToken(refreshToken)]);
    assert.equal(accessHashes.includes(accessToken), false);
    assert.equal(refreshHashes.includes(refreshToken), false);
  } finally {
    database.close();
  }

  const restoredStore = new SqliteOAuthStore(stateDir);
  try {
    const restoredClient = restoredStore.getClient(client.client_id);
    assert.equal(restoredClient?.client_id, client.client_id);
    assert.equal(restoredStore.getAccessToken(hashToken(accessToken))?.resource, mcpUrl.href);
    assert.equal(restoredStore.getRefreshToken(hashToken(refreshToken))?.clientId, client.client_id);
  } finally {
    restoredStore.close();
  }
}

function testRedirectHostAllowlist(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const clients = new SqliteOAuthClientsStore(store, [
      ...oauthConfig.allowedRedirectHosts,
      rocheRedirectHost,
    ]);

    const rocheClient = clients.registerClient({
      redirect_uris: [`https://${rocheRedirectHost}/roche-devspace-callback`],
      client_name: "Roche Extension",
    });
    assert.equal(store.getClient(rocheClient.client_id)?.client_name, "Roche Extension");

    const chatgptClient = clients.registerClient({ redirect_uris: [redirectUri] });
    assert.ok(store.getClient(chatgptClient.client_id));

    const loopbackClient = clients.registerClient({
      redirect_uris: ["http://localhost:53211/callback", "http://127.0.0.1:53211/callback"],
    });
    assert.ok(store.getClient(loopbackClient.client_id));

    const registeredBeforeRejection = countRegisteredClients(store);

    assert.throws(
      () =>
        clients.registerClient({
          redirect_uris: [
            "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/roche-devspace-callback",
          ],
        }),
      InvalidRequestError,
    );
    assert.throws(
      () =>
        clients.registerClient({
          redirect_uris: [`https://evil.${rocheRedirectHost}/roche-devspace-callback`],
        }),
      InvalidRequestError,
    );
    assert.throws(
      () =>
        clients.registerClient({
          redirect_uris: [
            `https://${rocheRedirectHost}/roche-devspace-callback`,
            "https://attacker.example.com/callback",
          ],
        }),
      InvalidRequestError,
    );

    assert.equal(countRegisteredClients(store), registeredBeforeRejection);
  } finally {
    store.close();
  }
}

function countRegisteredClients(store: SqliteOAuthStore): number {
  return store["database"].sqlite
    .prepare("select count(*) from oauth_clients")
    .pluck()
    .get() as number;
}

function testExpiredTokenCleanup(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  store.saveTokenPair({
    accessTokenHash: "expired-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
  });
  store.close();

  const reopened = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(reopened.getAccessToken("expired-access-hash"), undefined);
    assert.equal(reopened.getRefreshToken("expired-refresh-hash"), undefined);
  } finally {
    reopened.close();
  }
}

function testTransactionalTokenRotation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    store.saveRefreshToken("old-refresh-hash", {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt,
    });

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "new-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "new-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      true,
    );
    assert.equal(store.getRefreshToken("old-refresh-hash"), undefined);
    assert.ok(store.getAccessToken("new-access-hash"));
    assert.ok(store.getRefreshToken("new-refresh-hash"));

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "losing-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "losing-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      false,
    );
    assert.equal(store.getAccessToken("losing-access-hash"), undefined);
    assert.equal(store.getRefreshToken("losing-refresh-hash"), undefined);
  } finally {
    store.close();
  }
}

async function testProviderRestartRotationAndRevocation(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const code = "code-test-123";
  firstProvider["codes"].set(code, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const issued = await firstProvider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const verified = await secondProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);

    const refreshed = await secondProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      ["devspace"],
      mcpUrl,
    );
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );

    await secondProvider.revokeToken(client, { token: refreshed.access_token });
    await assert.rejects(secondProvider.verifyAccessToken(refreshed.access_token), InvalidTokenError);

    await secondProvider.revokeToken(client, { token: refreshed.refresh_token });
    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, refreshed.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
