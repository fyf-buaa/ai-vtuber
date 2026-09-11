import { describe, expect, it } from "vitest";

import {
  ConfigDocumentError,
  REDACTED_VALUE,
  redactSecrets,
  restoreRedactedValues,
} from "../src/server/config-redaction.js";

describe("config redaction", () => {
  it.each([
    [
      "multiline Authorization",
      "Content-Type:application/json\nAuthorization:Bearer real-key",
      "real-key",
    ],
    [
      "JSON Proxy-Authorization",
      '{"Accept":"application/json","Proxy-Authorization":"Basic real-proxy"}',
      "real-proxy",
    ],
    ["Cookie", "Accept: */*\r\nCookie: session=real-cookie", "real-cookie"],
    [
      "Set-Cookie",
      "Set-Cookie: session=server-secret; HttpOnly",
      "server-secret",
    ],
    ["JSON-ish X-Api-Key", "{'X-Api-Key': 'real-x-key'}", "real-x-key"],
    ["API-key variant", '{"API_key":"real-api-key"}', "real-api-key"],
    ["compact API key variant", "xApiKey=real-compact-key", "real-compact-key"],
    [
      "Azure subscription key",
      "Ocp-Apim-Subscription-Key: real-subscription-key",
      "real-subscription-key",
    ],
    ["dotted API key", "X.Api.Key: real-dotted-key", "real-dotted-key"],
    ["access key suffix", "X-Access-Key: real-access-key", "real-access-key"],
    ["auth key suffix", "X-Auth-Key: real-auth-key", "real-auth-key"],
  ])("uses a whole-value GET placeholder for %s", (_label, headers, secret) => {
    const redacted = redactSecrets({ legacy: { headers } });
    const serialized = JSON.stringify(redacted);

    expect(JSON.parse(serialized)).toEqual({
      legacy: { headers: REDACTED_VALUE },
    });
    expect(serialized).not.toContain(secret);
  });

  it("redacts credential header object keys with normalized suffixes", () => {
    expect(
      JSON.parse(JSON.stringify(redactSecrets({
        agent: {
          headers: {
            "X-Access-Key": "access-secret",
            "X-Auth-Key": "auth-secret",
            "Ocp-Apim-Subscription-Key": "subscription-secret",
            "X-Trace-Id": "safe",
          },
        },
      }))),
    ).toEqual({
      agent: {
        headers: {
          "X-Access-Key": REDACTED_VALUE,
          "X-Auth-Key": REDACTED_VALUE,
          "Ocp-Apim-Subscription-Key": REDACTED_VALUE,
          "X-Trace-Id": "safe",
        },
      },
    });
  });

  it("preserves empty credential values instead of inventing a redaction marker", () => {
    expect(
      JSON.parse(JSON.stringify(redactSecrets({
        agent: {
          apiKey: "",
          apiKeys: [],
          token: null,
        },
      }))),
    ).toEqual({
      agent: {
        apiKey: "",
        apiKeys: [],
        token: null,
      },
    });
  });

  it("redacts Bilibili SESSDATA cookie values", () => {
    expect(
      JSON.parse(
        JSON.stringify(
          redactSecrets({
            "bilibili-web": { room_id: 1, sessdata: "real-sessdata" },
          }),
        ),
      ),
    ).toEqual({
      "bilibili-web": { room_id: 1, sessdata: REDACTED_VALUE },
    });
  });

  it("preserves opaque header blobs without credential assignments", () => {
    const headers =
      "Content-Type:application/json\nAccept:text/event-stream\nX-Request-Id:request-123";

    expect(
      JSON.parse(JSON.stringify(redactSecrets({ legacy: { headers } }))),
    ).toEqual({
      legacy: { headers },
    });
  });

  it("restores an opaque secret header blob exactly after a redacted round trip", () => {
    const headers =
      "Content-Type:application/json\nAuthorization:Bearer real-key\nX-Trace:keep-me";
    const current = {
      custom_llm: { headers, method: "POST" },
      untouched: true,
    };
    const candidate = JSON.parse(
      JSON.stringify(redactSecrets(current)),
    ) as Record<string, unknown>;
    (candidate["custom_llm"] as Record<string, unknown>)["method"] = "PUT";

    const restored = restoreRedactedValues(candidate, current) as {
      custom_llm: { headers: string; method: string };
      untouched: boolean;
    };

    expect(restored.custom_llm.headers).toBe(headers);
    expect(restored.custom_llm.method).toBe("PUT");
    expect(restored.untouched).toBe(true);
  });

  it("rejects a replacement injected by editing the redaction placeholder", () => {
    const headers =
      "Content-Type:application/json\nAuthorization:Bearer real-key";
    const current = { custom_llm: { headers } };

    for (const replacement of [
      `${REDACTED_VALUE}\nAuthorization:Bearer replacement-key`,
      "redacted\nAuthorization:Bearer replacement-key",
    ]) {
      expect(() =>
        restoreRedactedValues(
          { custom_llm: { headers: replacement } },
          current,
        ),
      ).toThrow(ConfigDocumentError);
    }
  });
});
