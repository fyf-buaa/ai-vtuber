export interface PlatformAvailability {
  readonly id: string;
  readonly label: string;
  readonly status: "available" | "pending";
}

export const PLATFORM_CATALOG: readonly PlatformAvailability[] = Object.freeze([
  { id: "talk", label: "本地手动输入", status: "available" },
  { id: "bilibili-web", label: "哔哩哔哩 Web", status: "available" },
  { id: "bilibili-platform", label: "哔哩哔哩开放平台", status: "available" },
  { id: "youtube", label: "YouTube", status: "pending" },
  { id: "twitch", label: "Twitch", status: "pending" },
  { id: "ordinaryroad_barrage_fly", label: "让弹幕飞", status: "pending" },
]);

export function platformAvailability(platform: string): PlatformAvailability | undefined {
  const identifier = platform.trim().toLowerCase();
  return PLATFORM_CATALOG.find(({ id }) => id === identifier);
}

export function isPlatformAvailable(platform: string): boolean {
  const identifier = platform.trim().toLowerCase();
  return identifier === "stdin" || identifier === "manual"
    || platformAvailability(identifier)?.status === "available";
}

export function pendingPlatformForPath(
  path: readonly string[],
): PlatformAvailability | undefined {
  const identifier = path[0] === "webui" && path[1] === "show_card"
    && path[2] === "common_config"
    ? path[3]
    : path[0];
  if (identifier === undefined) return undefined;
  const platform = platformAvailability(identifier);
  return platform?.status === "pending" ? platform : undefined;
}

export const PENDING_PLATFORM_CONFIG_PATHS: readonly (readonly string[])[] =
  Object.freeze(PLATFORM_CATALOG.filter(({ status }) => status === "pending")
    .flatMap(({ id }) => [[id], ["webui", "show_card", "common_config", id]]));
