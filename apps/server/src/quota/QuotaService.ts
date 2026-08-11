/**
 * QuotaService - reads Claude and Codex subscription remaining windows.
 *
 * Claude uses the signed-in OAuth credential and Anthropic's usage endpoint.
 * Codex is queried through a short-lived `codex app-server` process. Tokens
 * and raw provider payloads never leave this module.
 *
 * @module QuotaService
 */
import * as NodeOS from "node:os";

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
  parseClaudeUsageWindows,
  parseCodexRateLimits,
} from "@t3tools/shared/quotaParse";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../pathExpansion.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import * as ServerSettings from "../serverSettings.ts";
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

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cache = new Map<QuotaProviderKind, QuotaCacheEntry>();

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
      planLabel: parsed.planLabel,
      fetchedAt,
      status: "ok",
      message: null,
      windows: parsed.windows,
    };
    storeSuccess(next, nowMs);
    return next;
  });

  const readSnapshot = Effect.fn("QuotaService.readSnapshot")(function* (
    input: QuotaSnapshotInput,
  ) {
    const refresh = input.refresh === true;
    const [claude, codex] = yield* Effect.all([readClaude(refresh), readCodex(refresh)], {
      concurrency: "unbounded",
    });
    const readAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    return {
      contractVersion: QUOTA_CONTRACT_VERSION,
      readAt,
      providers: [claude, codex],
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
