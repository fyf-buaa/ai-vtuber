import { describe, expect, it } from "vitest";

import {
  SETTINGS_CATALOG,
  categorizeSettingsKeys,
  settingsPathOptions,
} from "../web/settings-catalog.js";

function catalogKeys(): string[] {
  return SETTINGS_CATALOG.flatMap((category) =>
    category.sections.flatMap((section) => [...section.keys])
  );
}

describe("settings catalog", () => {
  it("assigns every known top-level config key exactly once", () => {
    const keys = catalogKeys();

    expect(new Set(keys).size).toBe(keys.length);
  });


  it("keeps unknown config in an explicit fallback category", () => {
    const groups = categorizeSettingsKeys(["platform", "future_provider"]);
    const fallback = groups.at(-1);

    expect(fallback).toMatchObject({
      id: "other",
      sections: [{ keys: ["future_provider"] }],
    });
  });

  it("describes finite and configuration-derived single-choice fields", () => {
    expect(settingsPathOptions(["comment_log_type"])?.map(({ value }) => value))
      .toEqual(["问答", "问题", "回答", "不记录"]);
    expect(
      settingsPathOptions(["gpt_sovits", "v2_api_0821", "text_split_method"])
        ?.map(({ value }) => value),
    ).toEqual(["cut0", "cut1", "cut2", "cut3", "cut4", "cut5"]);
    expect(
      settingsPathOptions(["webui", "theme", "choose"], {
        webui: {
          theme: {
            list: {
              "默认黑白": {},
              "蓝天白云": {},
            },
          },
        },
      }),
    ).toEqual([
      { value: "默认黑白", label: "默认黑白" },
      { value: "蓝天白云", label: "蓝天白云" },
    ]);
    expect(settingsPathOptions(["openai_tts", "api_key"])).toBeUndefined();
  });
});

