import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { parseClaudeOauthCredential } from "./QuotaService.ts";

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
