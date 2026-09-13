// @effect-diagnostics nodeBuiltinImport:off -- Fixture builds a throwaway Cursor state.vscdb with node:sqlite.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  createQuotaAccountFingerprint,
  isCursorAccessTokenExpiring,
  parseClaudeAccountId,
  parseClaudeOauthCredential,
  parseCodexAccountId,
  readCursorLocalAuth,
  readJwtSubject,
  resolveCursorStateDbPath,
} from "./QuotaService.ts";

describe("quota account fingerprints", () => {
  it("extracts stable provider account IDs and hashes them without exposing the source", () => {
    expect(parseClaudeAccountId('{"oauthAccount":{"accountUuid":"claude-account"}}')).toBe(
      "claude-account",
    );
    expect(parseCodexAccountId('{"tokens":{"account_id":"codex-account"}}')).toBe("codex-account");
    const fingerprint = createQuotaAccountFingerprint("claude", "claude-account");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("claude-account");
    expect(createQuotaAccountFingerprint("codex", "claude-account")).not.toBe(fingerprint);
    expect(createQuotaAccountFingerprint("antigravity", "claude-account")).not.toBe(fingerprint);
    expect(createQuotaAccountFingerprint("claude", null)).toBeNull();
  });

  it("reads Cursor's stable JWT subject", () => {
    const jwt = buildUnsignedJwt(1_900_000_000, "cursor-account");
    expect(readJwtSubject(jwt)).toBe("cursor-account");
    expect(readJwtSubject("not-a-jwt")).toBeNull();
  });
});

describe("parseClaudeOauthCredential", () => {
  it("reads the subscription token without putting it in failure messages", () => {
    const parsed = parseClaudeOauthCredential(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "secret-token-value",
          subscriptionType: "max",
        },
      }),
    );

    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      expect(parsed.success.accessToken).toBe("secret-token-value");
      expect(parsed.success.planLabel).toBe("Max");
    }
  });

  it("keeps malformed credential errors free of secret material", () => {
    const parsed = parseClaudeOauthCredential(
      `{"claudeAiOauth":{"accessToken":"secret-token-value"`,
    );
    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      expect(parsed.failure.message).not.toContain("secret-token-value");
      expect(JSON.stringify(parsed.failure)).not.toContain("secret-token-value");
    }
  });
});

describe("resolveCursorStateDbPath", () => {
  it("uses the Cursor app globalStorage database on each platform", () => {
    expect(
      resolveCursorStateDbPath({
        platform: "win32",
        homedir: "C:\\Users\\dev",
        appData: "C:\\Users\\dev\\AppData\\Roaming",
      }),
    ).toBe("C:\\Users\\dev\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb");
    expect(
      resolveCursorStateDbPath({
        platform: "darwin",
        homedir: "/Users/dev",
      }),
    ).toBe("/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    expect(
      resolveCursorStateDbPath({
        platform: "linux",
        homedir: "/home/dev",
        xdgConfigHome: "/home/dev/.config",
      }),
    ).toBe("/home/dev/.config/Cursor/User/globalStorage/state.vscdb");
  });
});

describe("isCursorAccessTokenExpiring", () => {
  it("treats tokens within two minutes of expiry as expiring", () => {
    const nowMs = Date.parse("2026-08-11T16:00:00.000Z");
    expect(isCursorAccessTokenExpiring(buildUnsignedJwt(nowMs / 1000 - 60), nowMs)).toBe(true);
    expect(isCursorAccessTokenExpiring(buildUnsignedJwt(nowMs / 1000 + 60), nowMs)).toBe(true);
    expect(isCursorAccessTokenExpiring(buildUnsignedJwt(nowMs / 1000 + 180), nowMs)).toBe(false);
    expect(isCursorAccessTokenExpiring("not-a-jwt", nowMs)).toBe(false);
  });
});

describe("readCursorLocalAuth", () => {
  it("reads ItemTable keys without putting tokens in failure messages", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-quota-"));
    const databasePath = NodePath.join(root, "state.vscdb");
    const database = new NodeSqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    database
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run("cursorAuth/accessToken", buildUnsignedJwt(1_900_000_000, "cursor-account"));
    database
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run("cursorAuth/refreshToken", "secret-refresh-token");
    database
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run("cursorAuth/stripeMembershipType", "pro");
    database.close();

    const parsed = readCursorLocalAuth(databasePath);
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      expect(parsed.success.accountId).toBe("cursor-account");
      expect(parsed.success.refreshToken).toBe("secret-refresh-token");
      expect(parsed.success.planLabel).toBe("Pro");
    }

    const missing = readCursorLocalAuth(NodePath.join(root, "missing.vscdb"));
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isFailure(missing)) {
      expect(missing.failure.message).not.toContain("secret-access-token");
      expect(JSON.stringify(missing.failure)).not.toContain("secret-refresh-token");
    }

    NodeFS.rmSync(root, { recursive: true, force: true });
  });
});

function buildUnsignedJwt(expSeconds: number, subject?: string): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  const payload = { exp: expSeconds, ...(subject ? { sub: subject } : {}) };
  return [encode("{}"), encode(JSON.stringify(payload)), "sig"].join(".");
}
