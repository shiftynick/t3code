// @effect-diagnostics nodeBuiltinImport:off -- Cursor state.vscdb lives at OS-specific app-data paths; sqlite is opened read-only with node:sqlite.
/**
 * QuotaService - reads Claude, Codex, Cursor, and Antigravity subscription remaining windows.
 *
 * Claude uses the signed-in OAuth credential and Anthropic's usage endpoint.
 * Codex is queried through a short-lived `codex app-server` process. Cursor
 * reads the desktop app's local SQLite sign-in read-only and calls Cursor's
 * usage API. Antigravity queries the local `agy` CLI in print-mode. Tokens and
 * raw provider payloads never leave this module.
 *
 * @module QuotaService
 */
import { createHash } from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  QUOTA_CONTRACT_VERSION,
  type QuotaProviderKind,
  type QuotaProviderSnapshot,
  type QuotaSnapshot,
  type QuotaSnapshotInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  emptyProviderSnapshot,
  humanizeQuotaName,
  parseAntigravityUsageQuota,
  parseClaudeUsageWindows,
  parseCodexRateLimits,
  parseCursorPeriodUsage,
} from "@t3tools/shared/quotaParse";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../pathExpansion.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import * as ServerSettings from "../serverSettings.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import packageJson from "../../package.json" with { type: "json" };
import {
  parseRetryAfterMs,
  QUOTA_SUCCESS_CACHE_MS,
  shouldUseCachedSnapshot,
  type QuotaCacheEntry,
} from "./quotaCache.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_REQUEST_TIMEOUT_MS = 15_000;
const CODEX_REQUEST_TIMEOUT_MS = 20_000;
const CODEX_FORCE_KILL_AFTER = "2 seconds" as const;
const ANTIGRAVITY_REQUEST_TIMEOUT_MS = 15_000;
const ANTIGRAVITY_FORCE_KILL_AFTER = "2 seconds" as const;
const CURSOR_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const CURSOR_TOKEN_URL = "https://api2.cursor.sh/oauth/token";
const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CURSOR_REQUEST_TIMEOUT_MS = 15_000;
const CURSOR_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const CURSOR_REFRESH_TOKEN_KEY = "cursorAuth/refreshToken";
const CURSOR_MEMBERSHIP_TYPE_KEY = "cursorAuth/stripeMembershipType";
const CURSOR_JWT_REFRESH_SKEW_MS = 2 * 60_000;
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);

interface ClaudeOauthCredential {
  readonly accessToken: string;
  readonly planLabel: string | null;
}

export class QuotaService extends Context.Service<
  QuotaService,
  {
    readonly readSnapshot: (input: QuotaSnapshotInput) => Effect.Effect<QuotaSnapshot>;
  }
>()("t3/quota/QuotaService") {}

export const layerTest = Layer.succeed(
  QuotaService,
  QuotaService.of({
    readSnapshot: () =>
      Effect.map(DateTime.now, (now) => ({
        contractVersion: QUOTA_CONTRACT_VERSION,
        readAt: DateTime.formatIso(now),
        providers: [],
      })),
  }),
);

const markCached = (
  snapshot: QuotaProviderSnapshot,
  status: QuotaProviderSnapshot["status"],
  message: string | null,
): QuotaProviderSnapshot => ({
  ...snapshot,
  status,
  message,
});

export const resolveClaudeCredentialsPath = Effect.fn("resolveClaudeCredentialsPath")(function* (
  configuredHomePath: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const trimmed = configuredHomePath.trim();
  if (trimmed.length > 0) {
    const resolvedHome = yield* resolveClaudeHomePath({ homePath: trimmed });
    return path.join(resolvedHome, ".credentials.json");
  }
  const envConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (envConfigDir.length > 0) {
    return path.join(path.resolve(expandHomePath(envConfigDir)), ".credentials.json");
  }
  return path.join(NodeOS.homedir(), ".claude", ".credentials.json");
});

const readClaudeOauthCredential = Effect.fn("readClaudeOauthCredential")(function* (
  credentialPath: string,
): Effect.fn.Return<
  Result.Result<ClaudeOauthCredential, QuotaProviderSnapshot>,
  never,
  FileSystem.FileSystem
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(credentialPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return Result.fail(
      emptyProviderSnapshot(
        "claude",
        "unauthenticated",
        "Claude Code is not signed in with a subscription. Run claude /login.",
      ),
    );
  }

  const raw = yield* fileSystem.readFileString(credentialPath).pipe(Effect.result);
  if (Result.isFailure(raw)) {
    return Result.fail(
      emptyProviderSnapshot("claude", "failed", "Claude credentials could not be read."),
    );
  }

  return parseClaudeOauthCredential(raw.success);
});

export function parseClaudeOauthCredential(
  raw: string,
): Result.Result<ClaudeOauthCredential, QuotaProviderSnapshot> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Result.fail(
      emptyProviderSnapshot("claude", "failed", "Claude credentials file is unreadable."),
    );
  }

  const oauth =
    parsed !== null && typeof parsed === "object" && "claudeAiOauth" in parsed
      ? (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
      : undefined;
  const record =
    oauth !== null && typeof oauth === "object" ? (oauth as Record<string, unknown>) : null;
  const accessToken = typeof record?.accessToken === "string" ? record.accessToken.trim() : "";
  if (accessToken.length === 0) {
    return Result.fail(
      emptyProviderSnapshot(
        "claude",
        "unauthenticated",
        "Claude Code is not signed in with a subscription.",
      ),
    );
  }
  const subscriptionType =
    typeof record?.subscriptionType === "string" ? record.subscriptionType.trim() : "";
  return Result.succeed({
    accessToken,
    planLabel: subscriptionType.length > 0 ? humanizeQuotaName(subscriptionType) : null,
  });
}

interface CursorLocalAuth {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly planLabel: string | null;
  readonly accountId: string | null;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseClaudeAccountId(raw: string): string | null {
  const oauthAccount = parseJsonRecord(raw)?.oauthAccount;
  if (oauthAccount === null || typeof oauthAccount !== "object" || Array.isArray(oauthAccount)) {
    return null;
  }
  const accountUuid = (oauthAccount as Record<string, unknown>).accountUuid;
  return typeof accountUuid === "string" && accountUuid.trim().length > 0
    ? accountUuid.trim()
    : null;
}

export function parseCodexAccountId(raw: string): string | null {
  const tokens = parseJsonRecord(raw)?.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const accountId = (tokens as Record<string, unknown>).account_id;
  return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : null;
}

export function createQuotaAccountFingerprint(
  provider: QuotaProviderKind,
  accountId: string | null,
): string | null {
  if (accountId === null || accountId.trim().length === 0) return null;
  return createHash("sha256")
    .update(`t3-quota-account:v1\0${provider}\0${accountId.trim()}`)
    .digest("hex");
}

export function resolveCursorStateDbPath(input: {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly appData?: string;
  readonly xdgConfigHome?: string;
}): string {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  if (input.platform === "win32") {
    const appData = input.appData?.trim() || path.join(input.homedir, "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (input.platform === "darwin") {
    return path.join(
      input.homedir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  const configHome = input.xdgConfigHome?.trim() || path.join(input.homedir, ".config");
  return path.join(configHome, "Cursor", "User", "globalStorage", "state.vscdb");
}

export function isCursorAccessTokenExpiring(jwt: string, nowMs: number): boolean {
  const expiryMs = readJwtExpiryMs(jwt);
  if (expiryMs === null) return false;
  return expiryMs <= nowMs + CURSOR_JWT_REFRESH_SKEW_MS;
}

function readJwtExpiryMs(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = decodeJwtPayload(parts[1]!);
    if (payload === null || typeof payload !== "object" || !("exp" in payload)) return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

export function readJwtSubject(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = decodeJwtPayload(parts[1]!);
    if (payload === null || typeof payload !== "object" || !("sub" in payload)) return null;
    const subject = (payload as { sub?: unknown }).sub;
    return typeof subject === "string" && subject.trim().length > 0 ? subject.trim() : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(segment: string): unknown {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return JSON.parse(Buffer.from(`${padded}${pad}`, "base64").toString("utf8"));
}

function readCursorItemValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8").trim();
  return "";
}

export function readCursorLocalAuth(
  databasePath: string,
): Result.Result<CursorLocalAuth, QuotaProviderSnapshot> {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    const statement = database.prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1");
    const read = (key: string) => {
      const row = statement.get(key) as { value?: unknown } | undefined;
      return readCursorItemValue(row?.value);
    };
    const accessToken = read(CURSOR_ACCESS_TOKEN_KEY);
    const refreshToken = read(CURSOR_REFRESH_TOKEN_KEY);
    const membershipType = read(CURSOR_MEMBERSHIP_TYPE_KEY);
    if (accessToken.length === 0 || refreshToken.length === 0) {
      return Result.fail(
        emptyProviderSnapshot(
          "cursor",
          "unauthenticated",
          "Cursor is not signed in on this computer. Open the Cursor app and sign in.",
        ),
      );
    }
    return Result.succeed({
      accessToken,
      refreshToken,
      planLabel: membershipType.length > 0 ? humanizeQuotaName(membershipType) : null,
      accountId: readJwtSubject(accessToken),
    });
  } catch {
    return Result.fail(
      emptyProviderSnapshot(
        "cursor",
        "failed",
        "Could not read Cursor sign-in state. Quit Cursor and try again, or sign in again.",
      ),
    );
  } finally {
    database?.close();
  }
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cache = new Map<QuotaProviderKind, QuotaCacheEntry>();

  const readAccountFingerprint = Effect.fn("QuotaService.readAccountFingerprint")(function* (
    provider: QuotaProviderKind,
    candidatePaths: readonly string[],
    parseAccountId: (raw: string) => string | null,
  ) {
    for (const candidatePath of candidatePaths) {
      const raw = yield* fileSystem.readFileString(candidatePath).pipe(Effect.option);
      if (Option.isNone(raw)) continue;
      const fingerprint = createQuotaAccountFingerprint(provider, parseAccountId(raw.value));
      if (fingerprint !== null) return fingerprint;
    }
    return null;
  });

  const readSettings = Effect.fn("QuotaService.readSettings")(function* () {
    return yield* settingsService.getSettings.pipe(Effect.catchCause(() => Effect.succeed(null)));
  });

  const cachedOr = (
    provider: QuotaProviderKind,
    fallback: QuotaProviderSnapshot,
    nowMs: number,
  ) => {
    const cached = cache.get(provider);
    if (cached === undefined) return fallback;
    return markCached(
      {
        ...cached.snapshot,
        windows: cached.snapshot.windows,
      },
      cached.snapshot.windows.length > 0 ? "stale" : fallback.status,
      fallback.message,
    );
  };

  const storeSuccess = (snapshot: QuotaProviderSnapshot, nowMs: number) => {
    cache.set(snapshot.provider, {
      snapshot,
      validUntilMs: nowMs + QUOTA_SUCCESS_CACHE_MS,
      lastRequestAtMs: nowMs,
      rateLimitedUntilMs: 0,
    });
  };

  const readClaude = Effect.fn("QuotaService.readClaude")(function* (refresh: boolean) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = cache.get("claude");
    if (shouldUseCachedSnapshot({ cached, nowMs, refresh })) {
      if (cached!.rateLimitedUntilMs > nowMs) {
        return markCached(
          cached!.snapshot,
          "rateLimited",
          "Claude is rate limiting quota checks. Showing the last reading.",
        );
      }
      return cached!.snapshot;
    }

    const settings = yield* readSettings();
    const configuredHomePath = settings?.providers.claudeAgent.homePath ?? "";
    const credentialPath = yield* resolveClaudeCredentialsPath(configuredHomePath);
    const credential = yield* readClaudeOauthCredential(credentialPath);
    if (Result.isFailure(credential)) {
      return cachedOr("claude", credential.failure, nowMs);
    }
    const credentialDirectory = path.dirname(credentialPath);
    const accountFingerprint = yield* readAccountFingerprint(
      "claude",
      [
        path.join(credentialDirectory, ".claude.json"),
        path.join(path.dirname(credentialDirectory), ".claude.json"),
      ],
      parseClaudeAccountId,
    );

    const request = HttpClientRequest.get(CLAUDE_USAGE_URL).pipe(
      HttpClientRequest.bearerToken(credential.success.accessToken),
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
    );
    const response = yield* httpClient
      .execute(request)
      .pipe(Effect.timeoutOption(CLAUDE_REQUEST_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(response)) {
      return cachedOr(
        "claude",
        emptyProviderSnapshot("claude", "failed", "Claude quota request failed."),
        nowMs,
      );
    }
    if (Option.isNone(response.success)) {
      return cachedOr(
        "claude",
        emptyProviderSnapshot("claude", "failed", "Claude quota request timed out."),
        nowMs,
      );
    }

    const httpResponse = response.success.value;
    if (httpResponse.status === 429) {
      const retryAfterMs = parseRetryAfterMs(httpResponse.headers["retry-after"], nowMs);
      if (cached !== undefined) {
        cache.set("claude", {
          ...cached,
          lastRequestAtMs: nowMs,
          rateLimitedUntilMs: nowMs + retryAfterMs,
        });
        return markCached(
          cached.snapshot,
          "rateLimited",
          "Claude is rate limiting quota checks. Showing the last reading.",
        );
      }
      return emptyProviderSnapshot(
        "claude",
        "rateLimited",
        "Claude is rate limiting quota checks. Try again later.",
      );
    }
    if (httpResponse.status === 401 || httpResponse.status === 403) {
      return emptyProviderSnapshot(
        "claude",
        "unauthenticated",
        "Claude subscription sign-in expired. Run claude /login.",
      );
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return cachedOr(
        "claude",
        emptyProviderSnapshot("claude", "failed", "Claude quota request failed."),
        nowMs,
      );
    }

    const payload = yield* httpResponse.json.pipe(Effect.result);
    if (Result.isFailure(payload)) {
      return cachedOr(
        "claude",
        emptyProviderSnapshot("claude", "failed", "Claude quota response was unreadable."),
        nowMs,
      );
    }

    const fetchedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const snapshot: QuotaProviderSnapshot = {
      provider: "claude",
      accountFingerprint,
      planLabel: credential.success.planLabel,
      fetchedAt,
      status: "ok",
      message: null,
      windows: parseClaudeUsageWindows(payload.success),
    };
    storeSuccess(snapshot, nowMs);
    return snapshot;
  });

  const readCodex = Effect.fn("QuotaService.readCodex")(function* (refresh: boolean) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = cache.get("codex");
    if (shouldUseCachedSnapshot({ cached, nowMs, refresh })) {
      return cached!.snapshot;
    }

    const settings = yield* readSettings();
    if (settings === null) {
      return cachedOr(
        "codex",
        emptyProviderSnapshot("codex", "failed", "Server settings could not be read."),
        nowMs,
      );
    }
    const codexSettings = settings.providers.codex;
    if (!codexSettings.enabled) {
      return emptyProviderSnapshot(
        "codex",
        "unavailable",
        "Codex is disabled in T3 Code settings.",
      );
    }

    const layout = yield* resolveCodexHomeLayout(codexSettings);
    const accountFingerprint = yield* readAccountFingerprint(
      "codex",
      [path.join(layout.effectiveHomePath ?? layout.sharedHomePath, "auth.json")],
      parseCodexAccountId,
    );
    const environment = {
      ...process.env,
      ...(layout.effectiveHomePath ? { CODEX_HOME: layout.effectiveHomePath } : {}),
    };
    const launchArgs = resolveCodexLaunchArgs(codexSettings.launchArgs, environment);
    const snapshot = yield* Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnCommand = yield* resolveSpawnCommand(
          codexSettings.binaryPath,
          codexAppServerArgs(launchArgs),
          {
            env: environment,
            extendEnv: true,
          },
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd: process.cwd(),
              env: environment,
              extendEnv: true,
              forceKillAfter: CODEX_FORCE_KILL_AFTER,
              shell: spawnCommand.shell,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new CodexErrors.CodexAppServerSpawnError({
                  command: `${codexSettings.binaryPath} app-server`,
                  cause,
                }),
            ),
          );
        const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );
        yield* client.request("initialize", {
          clientInfo: {
            name: "t3code",
            title: "T3 Code",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
          },
        });
        yield* client.notify("initialized", undefined);
        return yield* client.request("account/rateLimits/read", undefined);
      }),
    ).pipe(Effect.timeoutOption(Duration.millis(CODEX_REQUEST_TIMEOUT_MS)), Effect.result);

    if (Result.isFailure(snapshot)) {
      const error = snapshot.failure;
      if (isCodexAppServerSpawnError(error)) {
        return emptyProviderSnapshot(
          "codex",
          "unavailable",
          "Codex CLI is not installed or not on PATH.",
        );
      }
      return cachedOr(
        "codex",
        emptyProviderSnapshot("codex", "failed", "Codex quota request failed."),
        nowMs,
      );
    }
    if (Option.isNone(snapshot.success)) {
      return cachedOr(
        "codex",
        emptyProviderSnapshot("codex", "failed", "Codex quota request timed out."),
        nowMs,
      );
    }

    const parsed = parseCodexRateLimits(snapshot.success.value);
    if (parsed.windows.length === 0) {
      return emptyProviderSnapshot(
        "codex",
        "unauthenticated",
        "Codex returned no subscription rate limits. Sign in with ChatGPT in Codex.",
      );
    }

    const fetchedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const next: QuotaProviderSnapshot = {
      provider: "codex",
      accountFingerprint,
      planLabel: parsed.planLabel,
      fetchedAt,
      status: "ok",
      message: null,
      windows: parsed.windows,
    };
    storeSuccess(next, nowMs);
    return next;
  });

  const executeCursorRequest = (request: HttpClientRequest.HttpClientRequest) =>
    httpClient
      .execute(request)
      .pipe(Effect.timeoutOption(CURSOR_REQUEST_TIMEOUT_MS), Effect.result);

  const refreshCursorAccessToken = Effect.fn("QuotaService.refreshCursorAccessToken")(function* (
    refreshToken: string,
  ): Effect.fn.Return<Result.Result<string, QuotaProviderSnapshot>> {
    const request = HttpClientRequest.post(CURSOR_TOKEN_URL).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        grant_type: "refresh_token",
        client_id: CURSOR_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    );
    const response = yield* executeCursorRequest(request);
    if (Result.isFailure(response)) {
      return Result.fail(emptyProviderSnapshot("cursor", "failed", "Cursor token refresh failed."));
    }
    if (Option.isNone(response.success)) {
      return Result.fail(
        emptyProviderSnapshot("cursor", "failed", "Cursor token refresh timed out."),
      );
    }
    const httpResponse = response.success.value;
    const payload = yield* httpResponse.json.pipe(Effect.result);
    if (
      Result.isFailure(payload) ||
      payload.success === null ||
      typeof payload.success !== "object"
    ) {
      return Result.fail(
        emptyProviderSnapshot(
          "cursor",
          "unauthenticated",
          "Cursor sign-in expired. Open the Cursor app and sign in again.",
        ),
      );
    }
    const record = payload.success as Record<string, unknown>;
    if (record.shouldLogout === true) {
      return Result.fail(
        emptyProviderSnapshot(
          "cursor",
          "unauthenticated",
          "Cursor sign-in expired. Open the Cursor app and sign in again.",
        ),
      );
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return Result.fail(emptyProviderSnapshot("cursor", "failed", "Cursor token refresh failed."));
    }
    const accessToken = typeof record.access_token === "string" ? record.access_token.trim() : "";
    if (accessToken.length === 0) {
      return Result.fail(
        emptyProviderSnapshot(
          "cursor",
          "unauthenticated",
          "Cursor sign-in expired. Open the Cursor app and sign in again.",
        ),
      );
    }
    return Result.succeed(accessToken);
  });

  const requestCursorUsage = (accessToken: string) =>
    HttpClientRequest.post(CURSOR_USAGE_URL).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.setHeader("connect-protocol-version", "1"),
      HttpClientRequest.bodyJsonUnsafe({}),
    );

  const readCursor = Effect.fn("QuotaService.readCursor")(function* (refresh: boolean) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = cache.get("cursor");
    if (shouldUseCachedSnapshot({ cached, nowMs, refresh })) {
      if (cached!.rateLimitedUntilMs > nowMs) {
        return markCached(
          cached!.snapshot,
          "rateLimited",
          "Cursor is rate limiting quota checks. Showing the last reading.",
        );
      }
      return cached!.snapshot;
    }

    const databasePath = resolveCursorStateDbPath({
      platform: process.platform,
      homedir: NodeOS.homedir(),
      ...(process.env.APPDATA ? { appData: process.env.APPDATA } : {}),
      ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    });
    const exists = yield* fileSystem.exists(databasePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return cachedOr(
        "cursor",
        emptyProviderSnapshot(
          "cursor",
          "unauthenticated",
          "Cursor is not signed in on this computer. Open the Cursor app and sign in.",
        ),
        nowMs,
      );
    }

    const auth = readCursorLocalAuth(databasePath);
    if (Result.isFailure(auth)) {
      return cachedOr("cursor", auth.failure, nowMs);
    }

    let accessToken = auth.success.accessToken;
    if (isCursorAccessTokenExpiring(accessToken, nowMs)) {
      const refreshed = yield* refreshCursorAccessToken(auth.success.refreshToken);
      if (Result.isFailure(refreshed)) {
        return cachedOr("cursor", refreshed.failure, nowMs);
      }
      accessToken = refreshed.success;
    }

    const first = yield* executeCursorRequest(requestCursorUsage(accessToken));
    if (Result.isFailure(first)) {
      return cachedOr(
        "cursor",
        emptyProviderSnapshot("cursor", "failed", "Cursor quota request failed."),
        nowMs,
      );
    }
    if (Option.isNone(first.success)) {
      return cachedOr(
        "cursor",
        emptyProviderSnapshot("cursor", "failed", "Cursor quota request timed out."),
        nowMs,
      );
    }

    let httpResponse = first.success.value;
    if (httpResponse.status === 401 || httpResponse.status === 403) {
      const refreshed = yield* refreshCursorAccessToken(auth.success.refreshToken);
      if (Result.isFailure(refreshed)) {
        return cachedOr("cursor", refreshed.failure, nowMs);
      }
      const retry = yield* executeCursorRequest(requestCursorUsage(refreshed.success));
      if (Result.isFailure(retry)) {
        return cachedOr(
          "cursor",
          emptyProviderSnapshot("cursor", "failed", "Cursor quota request failed."),
          nowMs,
        );
      }
      if (Option.isNone(retry.success)) {
        return cachedOr(
          "cursor",
          emptyProviderSnapshot("cursor", "failed", "Cursor quota request timed out."),
          nowMs,
        );
      }
      httpResponse = retry.success.value;
    }

    if (httpResponse.status === 429) {
      const retryAfterMs = parseRetryAfterMs(httpResponse.headers["retry-after"], nowMs);
      if (cached !== undefined) {
        cache.set("cursor", {
          ...cached,
          lastRequestAtMs: nowMs,
          rateLimitedUntilMs: nowMs + retryAfterMs,
        });
        return markCached(
          cached.snapshot,
          "rateLimited",
          "Cursor is rate limiting quota checks. Showing the last reading.",
        );
      }
      return emptyProviderSnapshot(
        "cursor",
        "rateLimited",
        "Cursor is rate limiting quota checks. Try again later.",
      );
    }
    if (httpResponse.status === 401 || httpResponse.status === 403) {
      return emptyProviderSnapshot(
        "cursor",
        "unauthenticated",
        "Cursor sign-in expired. Open the Cursor app and sign in again.",
      );
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return cachedOr(
        "cursor",
        emptyProviderSnapshot("cursor", "failed", "Cursor quota request failed."),
        nowMs,
      );
    }

    const payload = yield* httpResponse.json.pipe(Effect.result);
    if (Result.isFailure(payload)) {
      return cachedOr(
        "cursor",
        emptyProviderSnapshot("cursor", "failed", "Cursor quota response was unreadable."),
        nowMs,
      );
    }

    const parsed = parseCursorPeriodUsage(payload.success, auth.success.planLabel);
    if (parsed.windows.length === 0) {
      return emptyProviderSnapshot(
        "cursor",
        "unauthenticated",
        "Cursor returned no plan usage. Sign in to the Cursor app and open the dashboard once.",
      );
    }

    const fetchedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const snapshot: QuotaProviderSnapshot = {
      provider: "cursor",
      accountFingerprint: createQuotaAccountFingerprint("cursor", auth.success.accountId),
      planLabel: parsed.planLabel,
      fetchedAt,
      status: "ok",
      message: null,
      windows: parsed.windows,
    };
    storeSuccess(snapshot, nowMs);
    return snapshot;
  });

  const readAntigravity = Effect.fn("QuotaService.readAntigravity")(function* (refresh: boolean) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = cache.get("antigravity");
    if (shouldUseCachedSnapshot({ cached, nowMs, refresh })) {
      if (cached!.rateLimitedUntilMs > nowMs) {
        return markCached(
          cached!.snapshot,
          "rateLimited",
          "Antigravity is rate limiting quota checks. Showing the last reading.",
        );
      }
      return cached!.snapshot;
    }

    const settings = yield* readSettings();
    const antigravitySettings = settings?.providers.antigravity;
    const configuredBinary = antigravitySettings?.binaryPath?.trim();
    const candidates = [
      ...(configuredBinary && configuredBinary.length > 0 ? [configuredBinary] : []),
      "agy",
      NodePath.join(NodeOS.homedir(), ".local", "bin", "agy"),
    ];

    let spawnSpec: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly shell: boolean;
    } | null = null;

    for (const candidate of candidates) {
      const resolved = yield* resolveSpawnCommand(
        candidate,
        ["-p", "/usage", "--output-format", "json"],
        { env: process.env, extendEnv: true },
      ).pipe(Effect.orElseSucceed(() => null));
      if (resolved !== null) {
        spawnSpec = resolved;
        break;
      }
    }

    if (spawnSpec === null) {
      return cachedOr(
        "antigravity",
        emptyProviderSnapshot(
          "antigravity",
          "unavailable",
          "Antigravity CLI (agy) is not installed or not on PATH.",
        ),
        nowMs,
      );
    }

    const installationIdPath = NodePath.join(
      NodeOS.homedir(),
      ".gemini",
      "antigravity-cli",
      "installation_id",
    );
    const accountFingerprint = yield* fileSystem.readFileString(installationIdPath).pipe(
      Effect.map((text) => createQuotaAccountFingerprint("antigravity", text.trim())),
      Effect.orElseSucceed(() => null),
    );

    const execResult = yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnSpec.command, spawnSpec.args, {
          cwd: process.cwd(),
          env: process.env,
          extendEnv: true,
          forceKillAfter: ANTIGRAVITY_FORCE_KILL_AFTER,
          shell: spawnSpec.shell,
        }),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 1024 * 1024 }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 64 * 1024 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: Number(exitCode),
      };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(ANTIGRAVITY_REQUEST_TIMEOUT_MS)),
      Effect.result,
    );

    if (Result.isFailure(execResult)) {
      return cachedOr(
        "antigravity",
        emptyProviderSnapshot("antigravity", "failed", "Antigravity quota request failed."),
        nowMs,
      );
    }

    if (Option.isNone(execResult.success)) {
      return cachedOr(
        "antigravity",
        emptyProviderSnapshot("antigravity", "failed", "Antigravity quota request timed out."),
        nowMs,
      );
    }

    const processOutput = execResult.success.value;
    if (processOutput.exitCode !== 0) {
      const combined = `${processOutput.stderr}\n${processOutput.stdout}`.toLowerCase();
      if (
        combined.includes("not logged in") ||
        combined.includes("authentication required") ||
        combined.includes("please sign in") ||
        combined.includes("cannot complete interactive login") ||
        combined.includes("unauthenticated")
      ) {
        return cachedOr(
          "antigravity",
          emptyProviderSnapshot(
            "antigravity",
            "unauthenticated",
            "Sign in to Antigravity with 'agy' to view quota.",
          ),
          nowMs,
        );
      }
      return cachedOr(
        "antigravity",
        emptyProviderSnapshot("antigravity", "failed", "Antigravity quota request failed."),
        nowMs,
      );
    }

    const parsedJsonOption = decodeUnknownJson(processOutput.stdout);
    if (Option.isNone(parsedJsonOption)) {
      return cachedOr(
        "antigravity",
        emptyProviderSnapshot("antigravity", "failed", "Antigravity returned invalid quota data."),
        nowMs,
      );
    }

    const parsed = parseAntigravityUsageQuota(parsedJsonOption.value);
    if (parsed.windows.length === 0) {
      return cachedOr(
        "antigravity",
        emptyProviderSnapshot(
          "antigravity",
          "unauthenticated",
          "Antigravity returned no quota windows. Check 'agy' sign-in.",
        ),
        nowMs,
      );
    }

    const fetchedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const snapshot: QuotaProviderSnapshot = {
      provider: "antigravity",
      accountFingerprint,
      planLabel: parsed.planLabel,
      fetchedAt,
      status: "ok",
      message: null,
      windows: parsed.windows,
    };
    storeSuccess(snapshot, nowMs);
    return snapshot;
  });

  const readSnapshot = Effect.fn("QuotaService.readSnapshot")(function* (
    input: QuotaSnapshotInput,
  ) {
    const refresh = input.refresh === true;
    const [claude, codex, cursor, antigravity] = yield* Effect.all(
      [readClaude(refresh), readCodex(refresh), readCursor(refresh), readAntigravity(refresh)],
      { concurrency: "unbounded" },
    );
    const readAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    return {
      contractVersion: QUOTA_CONTRACT_VERSION,
      readAt,
      providers: [claude, codex, cursor, antigravity],
    } satisfies QuotaSnapshot;
  });

  return {
    readSnapshot: (input: QuotaSnapshotInput) =>
      readSnapshot(input).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  } as const;
});

export const layer = Layer.effect(QuotaService, make);
