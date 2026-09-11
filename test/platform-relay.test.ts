import { describe, expect, it } from "vitest";

import {
  PlatformConfigurationError,
  createPlatformEventSource,
} from "../src/platforms/index.js";

describe("pending platform relay", () => {
  it("does not activate ordinaryroad relay configuration", () => {
    expect(() =>
      createPlatformEventSource({
        platform: "ordinaryroad_barrage_fly",
        ordinaryroad_barrage_fly: {
          ws_ip_port: "ws://relay.test/socket",
          taskIds: ["task-1"],
        },
      }),
    ).toThrow(PlatformConfigurationError);
    expect(() =>
      createPlatformEventSource({
        platform: "ordinaryroad_barrage_fly",
        ordinaryroad_barrage_fly: {
          ws_ip_port: "ws://relay.test/socket",
          taskIds: ["task-1"],
        },
      }),
    ).toThrow(/待完善.*bilibili-platform/u);
  });
});
