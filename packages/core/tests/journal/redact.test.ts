import { describe, it, expect } from "vitest";
import { redactArgs, defaultRedactConfig } from "../../src/journal/redact.js";

describe("redactArgs", () => {
  it("drops keys matching default sensitive list (case-insensitive)", () => {
    const out = redactArgs(
      { Password: "x", token: "y", AUTH: "z", file_id: 1 },
      defaultRedactConfig,
    );
    expect(out).toEqual({
      Password: "<redacted>",
      token: "<redacted>",
      AUTH: "<redacted>",
      file_id: 1,
    });
  });

  it("truncates string values larger than the configured limit", () => {
    const big = "x".repeat(2048);
    const out = redactArgs({ body: big }, { ...defaultRedactConfig, maxArgSizeBytes: 1024 });
    expect(out.body).toMatch(/^<truncated:\d+B>$/);
  });

  it("recurses into nested objects", () => {
    const out = redactArgs(
      { headers: { Authorization: "Bearer abc", "x-trace": "id" } },
      defaultRedactConfig,
    );
    expect((out.headers as any).Authorization).toBe("<redacted>");
    expect((out.headers as any)["x-trace"]).toBe("id");
  });

  it("respects extra_keys from config", () => {
    const out = redactArgs(
      { customer_id: "c1", file_id: 1 },
      { ...defaultRedactConfig, extraKeys: ["customer_id"] },
    );
    expect(out.customer_id).toBe("<redacted>");
    expect(out.file_id).toBe(1);
  });

  it("leaves arrays of primitives alone except for size cap", () => {
    const out = redactArgs({ ids: [1, 2, 3] }, defaultRedactConfig);
    expect(out.ids).toEqual([1, 2, 3]);
  });
});
