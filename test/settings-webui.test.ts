import { afterEach, describe, expect, it, vi } from "vitest";

const ELEMENT_IDS = [
  "settings-auth-form",
  "settings-token-input",
  "settings-connect",
  "settings-connection-mark",
  "settings-connection-label",
  "settings-connection-detail",
  "settings-announcement",
  "settings-section-nav",
  "settings-form",
  "settings-tree",
  "settings-empty",
  "settings-dirty-count",
  "settings-revision",
  "settings-reload",
  "settings-reset",
  "settings-expand-all",
  "settings-collapse-all",
  "settings-save",
  "settings-footer-time",
  "settings-agent-overview",
  "settings-agent-source",
  "settings-agent-route",
  "settings-agent-selection",
  "settings-agent-capability",
  "settings-agent-credential",
  "settings-agent-catalog-state",
] as const;

interface FakeEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

type FakeListener = (event: FakeEvent) => void;

function createFakeEvent(
  overrides: Partial<Pick<FakeEvent, "key" | "ctrlKey" | "metaKey" | "repeat">> = {},
): FakeEvent {
  const event: FakeEvent = {
    key: overrides.key ?? "",
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    repeat: overrides.repeat ?? false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  contains(name: string): boolean {
    return this.element.className.split(/\s+/u).includes(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const names = this.element.className.split(/\s+/u).filter((item) => item !== "");
    const present = names.includes(name);
    const enabled = force ?? !present;
    if (enabled && !present) names.push(name);
    if (!enabled && present) names.splice(names.indexOf(name), 1);
    this.element.className = names.join(" ");
    return enabled;
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList(this);
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, FakeListener[]>();
  parent: FakeElement | undefined;
  className = "";
  value = "";
  type = "";
  title = "";
  htmlFor = "";
  autocomplete = "";
  step = "";
  min = "";
  rows = 0;
  hidden = false;
  disabled = false;
  readOnly = false;
  checked = false;
  spellcheck = true;
  open = false;
  focusCalls = 0;
  #textContent = "";

  constructor(readonly tagName: string, public id = "") {}

  get textContent(): string {
    return `${this.#textContent}${this.children.map((child) => child.textContent).join("")}`;
  }

  set textContent(value: string) {
    this.#textContent = value;
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(
    type: string,
    overrides: Partial<Pick<FakeEvent, "key" | "ctrlKey" | "metaKey" | "repeat">> = {},
  ): FakeEvent {
    const event = createFakeEvent(overrides);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
    this.append(...children);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      for (const child of element.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  matches(selector: string): boolean {
    const notClass = selector.match(/^\.([\w-]+):not\(\.([\w-]+)\)$/u);
    if (notClass !== null) {
      return this.classList.contains(notClass[1] as string)
        && !this.classList.contains(notClass[2] as string);
    }
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toLocaleLowerCase("en-US");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  focus(): void {
    this.focusCalls += 1;
  }

  scrollIntoView(): void {}
}

class FakeInputElement extends FakeElement {
  constructor(id = "") {
    super("input", id);
  }
}

class FakeSelectElement extends FakeElement {
  constructor(id = "") {
    super("select", id);
  }
}

class FakeTextAreaElement extends FakeElement {
  constructor(id = "") {
    super("textarea", id);
  }
}

class FakeDocument {
  readonly elements: Partial<Record<(typeof ELEMENT_IDS)[number], FakeElement>> = {};
  readonly listeners = new Map<string, FakeListener[]>();

  constructor() {
    for (const id of ELEMENT_IDS) {
      this.elements[id] = id === "settings-token-input"
        ? new FakeInputElement(id)
        : new FakeElement(id.endsWith("form") ? "form" : "div", id);
    }
    const empty = this.element("settings-empty");
    empty.append(new FakeElement("strong"), new FakeElement("span"));
  }

  element(id: (typeof ELEMENT_IDS)[number]): FakeElement {
    const found = this.elements[id];
    if (found === undefined) throw new Error(`Missing fake element #${id}`);
    return found;
  }

  getElementById(id: string): FakeElement | null {
    return this.elements[id as (typeof ELEMENT_IDS)[number]] ?? null;
  }

  createElement(tagName: string): FakeElement {
    switch (tagName) {
      case "input":
        return new FakeInputElement();
      case "select":
        return new FakeSelectElement();
      case "textarea":
        return new FakeTextAreaElement();
      default:
        return new FakeElement(tagName);
    }
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(
    type: string,
    overrides: Partial<Pick<FakeEvent, "key" | "ctrlKey" | "metaKey" | "repeat">> = {},
  ): FakeEvent {
    const event = createFakeEvent(overrides);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

function renderedAndAccessibleText(document: FakeDocument): string {
  const text: string[] = [];
  const visit = (element: FakeElement): void => {
    text.push(element.textContent);
    if (element.title !== "") text.push(element.title);
    for (const [name, value] of element.attributes) {
      if (name.startsWith("aria-")) text.push(value);
    }
    for (const child of element.children) visit(child);
  };
  for (const element of Object.values(document.elements)) {
    if (element !== undefined) visit(element);
  }
  return text.join(" ");
}

class FakeWindow {
  readonly listeners = new Map<string, FakeListener[]>();
  #timer = 0;

  setTimeout(): number {
    this.#timer += 1;
    return this.#timer;
  }

  clearTimeout(): void {}

  setInterval(): number {
    this.#timer += 1;
    return this.#timer;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  confirm(): boolean {
    return true;
  }
}

class FakeStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function catalogFixture(source: "agent" | "default" = "agent"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    modes: [
      { id: "llm", name: "模型回复" },
      { id: "reread", name: "复读" },
      { id: "disabled", name: "停用" },
    ],
    source,
    suggestedAgent: {
      mode: "llm",
      provider: "fixture-a",
      model: "model-a",
      apiKey: "",
      baseUrl: "",
      systemPrompt: "fixture prompt",
      maxTokens: 80,
      contextWindow: 800,
      maxSessions: 100,
      thinkingLevel: "medium",
      reasoning: true,
      input: ["text"],
      tools: true,
      headers: {},
      samplingParams: {},
    },
    apiKeyConfigured: source === "agent",
    providers: [
      {
        id: "fixture-a",
        name: "Fixture A",
        models: [
          {
            id: "model-a",
            name: "Model A",
            api: "fixture-api-a",
            reasoning: true,
            input: ["text"],
            contextWindow: 800,
            maxTokens: 80,
            tools: true,
          },
          {
            id: "model-a2",
            name: "Model A2",
            api: "fixture-api-a",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 1_600,
            maxTokens: 160,
            tools: false,
          },
        ],
      },
      {
        id: "fixture-b",
        name: "Fixture B",
        models: [
          {
            id: "model-b",
            name: "Model B",
            api: "fixture-api-b",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 3_200,
            maxTokens: 320,
            tools: true,
          },
        ],
      },
      { id: "openai-compatible", name: "OpenAI Compatible", models: [] },
    ],
  };
}

function edgeVoiceCatalogFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    fetchedAt: 1_750_000_000_000,
    voices: [
      {
        shortName: "en-US-AvaNeural",
        gender: "Female",
        locale: "en-US",
        localeName: "English (United States)",
      },
      {
        shortName: "zh-CN-XiaoyiNeural",
        gender: "Female",
        locale: "zh-CN",
        localeName: "Chinese (Mainland)",
      },
    ],
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cloneFixture<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Fixture is not JSON serializable");
  return JSON.parse(serialized) as T;
}

function agentConfigFixture(
  catalog: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const suggested = catalog["suggestedAgent"] as Record<string, unknown>;
  return {
    agent: {
      ...cloneFixture(suggested),
      apiKey: "[REDACTED]",
      ...overrides,
    },
  };
}

async function waitUntil(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

class SettingsHarness {
  readonly document = new FakeDocument();
  readonly window = new FakeWindow();
  readonly storage = new FakeStorage();
  readonly requests: Array<{ path: string; init: RequestInit | undefined }> = [];
  readonly puts: Record<string, unknown>[] = [];
  readonly config: Record<string, unknown>;
  readonly catalog: Record<string, unknown>;
  catalogAfterSave: Record<string, unknown> | undefined;
  failCatalogRefresh = false;
  putFailure: { readonly payload: unknown; readonly status: number } | undefined;
  revision = 4;
  readOnlyPaths: readonly (readonly string[])[] = [];
  #configResponseGate: Promise<void> | undefined;
  #putResponseGate: Promise<void> | undefined;
  #successfulPut = false;

  constructor(
    config: Record<string, unknown> = agentConfigFixture(catalogFixture()),
    catalog: Record<string, unknown> = catalogFixture(),
  ) {
    this.config = config;
    this.catalog = catalog;
  }

  deferConfigResponse(): () => void {
    let release: () => void = () => {
      throw new Error("Config response gate was not initialized");
    };
    this.#configResponseGate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    return release;
  }

  deferPutResponse(): () => void {
    let release: () => void = () => {
      throw new Error("PUT response gate was not initialized");
    };
    this.#putResponseGate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    return release;
  }

  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    this.requests.push({ path, init });
    if (path === "/api/agent/catalog") {
      if (this.#successfulPut && this.failCatalogRefresh) {
        return jsonResponse({
          error: { code: "catalog_unavailable", message: "fixture catalog unavailable" },
        }, 503);
      }
      if (this.#successfulPut) {
        if (this.catalogAfterSave !== undefined) return jsonResponse(this.catalogAfterSave);
        const refreshed = cloneFixture(this.catalog);
        refreshed["source"] = "agent";
        const savedAgent = this.puts.at(-1)?.["agent"];
        const savedApiKey = typeof savedAgent === "object"
          && savedAgent !== null
          && !Array.isArray(savedAgent)
          && typeof (savedAgent as Record<string, unknown>)["apiKey"] === "string"
          ? (savedAgent as Record<string, unknown>)["apiKey"] as string
          : "";
        refreshed["apiKeyConfigured"] = savedApiKey !== "" && savedApiKey !== "[REDACTED]"
          ? true
          : this.catalog["apiKeyConfigured"];
        return jsonResponse(refreshed);
      }
      return jsonResponse(this.catalog);
    }
    if (path === "/api/speech/edge/voices") {
      return jsonResponse(edgeVoiceCatalogFixture());
    }
    if (path === "/api/config" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      this.puts.push(body);
      if (this.#putResponseGate !== undefined) await this.#putResponseGate;
      if (this.putFailure !== undefined) {
        return jsonResponse(this.putFailure.payload, this.putFailure.status);
      }
      this.revision += 1;
      this.#successfulPut = true;
      const responseConfig = cloneFixture(body);
      const responseAgent = responseConfig["agent"];
      if (typeof responseAgent === "object" && responseAgent !== null && !Array.isArray(responseAgent)) {
        const apiKey = (responseAgent as Record<string, unknown>)["apiKey"];
        if (typeof apiKey === "string" && apiKey !== "") {
          (responseAgent as Record<string, unknown>)["apiKey"] = "[REDACTED]";
        }
      }
      return jsonResponse({
        config: responseConfig,
        revision: this.revision,
        readOnlyPaths: this.readOnlyPaths,
      });
    }
    if (path === "/api/config") {
      if (this.#configResponseGate !== undefined) await this.#configResponseGate;
      return jsonResponse({
        config: this.config,
        revision: this.revision,
        readOnlyPaths: this.readOnlyPaths,
      });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  async bootstrap(): Promise<void> {
    vi.stubGlobal("document", this.document as unknown as Document);
    vi.stubGlobal("window", this.window as unknown as Window & typeof globalThis);
    vi.stubGlobal("sessionStorage", this.storage as unknown as Storage);
    vi.stubGlobal("HTMLInputElement", FakeInputElement);
    vi.stubGlobal("HTMLSelectElement", FakeSelectElement);
    vi.stubGlobal("HTMLTextAreaElement", FakeTextAreaElement);
    vi.stubGlobal("fetch", this.fetch);
    // The settings module reads browser globals during evaluation, so this test installs them first.
    await import("../web/settings.js");
  }

  async waitUntilReady(): Promise<void> {
    await waitUntil(
      () => this.document.element("settings-connection-label").textContent === "已连接",
      "settings config and catalog load",
    );
  }

  async start(): Promise<void> {
    await this.bootstrap();
    await this.waitUntilReady();
  }

  field(path: string): FakeElement {
    const tree = this.document.element("settings-tree");
    const field = tree.querySelectorAll(".settings-field")
      .find((element) => element.dataset["settingsPath"] === path);
    if (field === undefined) throw new Error(`Missing settings field ${path}`);
    return field;
  }

  control(path: string): FakeElement {
    const control = this.field(path).querySelector("input")
      ?? this.field(path).querySelector("select")
      ?? this.field(path).querySelector("textarea");
    if (control === null) throw new Error(`Missing settings control ${path}`);
    return control;
  }
}

let harness: SettingsHarness | undefined;

afterEach(() => {
  harness = undefined;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("structured Pi Agent settings", () => {
  it("waits for config before requesting the catalog and completes a partial agent accessibly", async () => {
    const catalog = catalogFixture("agent");
    const current = new SettingsHarness({
      agent: {
        mode: "llm",
        provider: "fixture-a",
        model: "model-a",
      },
      platform: "talk",
    }, catalog);
    harness = current;
    const releaseConfig = current.deferConfigResponse();
    await current.bootstrap();

    expect(current.requests.map(({ path }) => path)).toEqual(["/api/config"]);
    releaseConfig();
    await current.waitUntilReady();
    expect(current.requests.slice(0, 2).map(({ path }) => path)).toEqual([
      "/api/config",
      "/api/agent/catalog",
    ]);

    const agentPaths = current.document.element("settings-tree")
      .querySelectorAll(".settings-field")
      .map(({ dataset }) => dataset["settingsPath"])
      .filter((path): path is string => path?.startsWith("agent.") === true);
    expect(agentPaths).toEqual([
      "agent.mode",
      "agent.provider",
      "agent.model",
      "agent.apiKey",
      "agent.baseUrl",
      "agent.systemPrompt",
      "agent.maxTokens",
      "agent.contextWindow",
      "agent.maxSessions",
      "agent.thinkingLevel",
      "agent.reasoning",
      "agent.input",
      "agent.tools",
      "agent.headers",
      "agent.samplingParams",
    ]);

    const tree = current.document.element("settings-tree");
    expect(tree.querySelectorAll(".settings-field-path")).toEqual([]);
    expect(tree.querySelectorAll(".settings-reset-field")).toEqual([]);
    const sectionNavigation = current.document.element("settings-section-nav");
    expect(sectionNavigation.querySelectorAll("code")).toEqual([]);
    expect(sectionNavigation.textContent).toContain("Pi Agent 主配置");
    const navigationCategories = sectionNavigation.querySelectorAll(
      ".settings-nav-category",
    );
    expect(navigationCategories.length).toBeGreaterThan(1);
    expect(navigationCategories.every(({ tagName }) => tagName === "details"))
      .toBe(true);
    expect(navigationCategories[0]?.children[0]?.tagName).toBe("summary");
    expect(navigationCategories[0]?.open).toBe(true);
    expect(navigationCategories[1]?.open).toBe(false);
    for (const field of tree.querySelectorAll(".settings-field")) {
      const control = field.querySelector("input")
        ?? field.querySelector("select")
        ?? field.querySelector("textarea");
      if (control === null) throw new Error("Structured field is missing its control");
      const descriptions = [
        field.querySelector(".settings-field-help"),
        field.querySelector(".settings-field-error"),
      ].filter((element): element is FakeElement => element !== null);
      const describedBy = (control.attributes.get("aria-describedby") ?? "")
        .split(/\s+/u)
        .filter((id) => id !== "");
      expect(describedBy).toEqual(descriptions.map(({ id }) => id));
      const meta = field.querySelector(".settings-field-meta");
      if (meta === null) throw new Error("Structured field is missing its metadata container");
      expect(meta.children.every((item) =>
        item.classList.contains("settings-field-error")
        || item.classList.contains("settings-lock")
        || item.textContent === "敏感字段"
      )).toBe(true);
    }

    const providerField = current.field("agent.provider");
    expect(current.field("agent.mode").querySelector("label")?.textContent).toBe("运行模式");
    expect(providerField.querySelector("label")?.textContent).toBe("模型供应商");
    expect(current.control("agent.provider")).toBeInstanceOf(FakeSelectElement);
    const capabilityGroup = tree.querySelectorAll(".settings-capability-group")[0];
    expect(capabilityGroup?.dataset["settingsGroupPath"]).toBe("agent.capabilities");
    expect(capabilityGroup?.textContent).toContain("模型能力");
    for (const [path, label] of [
      ["agent.reasoning", "推理"],
      ["agent.input", "视觉"],
      ["agent.tools", "工具"],
    ] as const) {
      expect(current.field(path).querySelector("label")?.textContent).toBe(label);
      const capability = current.control(path);
      expect(capability).toBeInstanceOf(FakeInputElement);
      expect(capability.type).toBe("checkbox");
    }
    expect(current.control("agent.model")).toBeInstanceOf(FakeSelectElement);
    expect(current.field("agent.apiKey").querySelector(".settings-field-meta")?.textContent)
      .toContain("敏感字段");
    const mode = current.control("agent.mode");
    mode.value = "missing-mode";
    mode.dispatch("change");
    expect(current.field("agent.mode").querySelector(".settings-field-error")?.textContent)
      .toContain("请选择有效的 Agent 运行模式");
    expect(current.document.element("settings-agent-catalog-state").textContent)
      .toContain("运行模式");
    const surfaceText = renderedAndAccessibleText(current.document);
    expect(surfaceText).not.toContain("$.agent.mode");
    expect(surfaceText).not.toContain("$.agent.provider");
    expect(surfaceText).not.toContain("目录选择");
    expect(surfaceText).not.toContain("撤销此项");
  });

  it("mounts a dedicated Pi visual fallback without changing the primary model", async () => {
    const catalog = catalogFixture();
    const current = new SettingsHarness({
      ...agentConfigFixture(catalog, {
        mode: "reread",
        provider: "fixture-a",
        model: "model-a",
        input: ["text"],
      }),
      image_recognition: {
        enable: false,
        provider: "fixture-a",
        model: "model-a2",
        apiKey: "dedicated-vision-key",
        baseUrl: "",
        systemPrompt: "只转述图片中的可见内容。",
        prompt: "请讲解一下图片里的内容",
        maxTokens: 160,
        contextWindow: 1_600,
        maxSessions: 8,
        thinkingLevel: "off",
        reasoning: false,
        headers: {},
        samplingParams: {},
      },
    }, catalog);
    harness = current;
    await current.start();

    const tree = current.document.element("settings-tree");
    expect(tree.children.find(({ dataset }) => dataset["category"] === "image"))
      .toBeUndefined();
    const imageGroup = tree.querySelectorAll(".settings-group")
      .find(({ dataset }) => dataset["settingsGroupPath"] === "image_recognition");
    expect(imageGroup).toBeDefined();
    expect(imageGroup?.open).toBe(false);
    expect(imageGroup?.parent?.parent?.dataset["section"]).toBe("agent:pi-agent");

    const enable = current.control("image_recognition.enable");
    expect(enable).toBeInstanceOf(FakeInputElement);
    expect(enable.type).toBe("checkbox");
    expect(enable.attributes.get("role")).toBe("switch");
    expect(enable.attributes.get("aria-label")).toBe("启用专用视觉模型");
    expect(current.control("agent.model").disabled).toBe(true);
    expect(current.control("image_recognition.provider").disabled).toBe(true);
    expect(current.control("image_recognition.prompt").disabled).toBe(true);

    enable.checked = true;
    enable.dispatch("change");
    expect(current.control("agent.model").disabled).toBe(true);
    expect(current.control("agent.model").value).toBe("model-a");
    expect(current.control("agent.input").checked).toBe(false);
    expect(current.control("image_recognition.provider").disabled).toBe(false);
    expect(current.control("image_recognition.prompt").disabled).toBe(false);
    const visualModel = current.control("image_recognition.model");
    expect(visualModel.disabled).toBe(false);
    expect(visualModel.children.map(({ value }) => value)).toEqual(["model-a2"]);
    expect(visualModel.value).toBe("model-a2");
    expect(
      current.field("image_recognition.model")
        .querySelector(".settings-field-help")?.textContent,
    ).toContain("只列出支持 image 输入的模型");
    expect(current.document.element("settings-agent-catalog-state").textContent)
      .toContain("图片由专用 Pi 视觉模型转述");

    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.document.element("settings-connection-label").textContent === "已连接"
        && current.requests.filter(({ path }) => path === "/api/agent/catalog").length === 2,
      "completed dedicated visual settings PUT",
    );
    expect(current.puts[0]?.["agent"]).toMatchObject({
      mode: "reread",
      provider: "fixture-a",
      model: "model-a",
      input: ["text"],
    });
    expect(current.puts[0]?.["image_recognition"]).toMatchObject({
      enable: true,
      provider: "fixture-a",
      model: "model-a2",
      systemPrompt: "只转述图片中的可见内容。",
      prompt: "请讲解一下图片里的内容",
    });
    expect(current.puts[0]?.["image_recognition"]).not.toHaveProperty(
      "loop_screenshot_enable",
    );
    expect(current.puts[0]?.["image_recognition"]).not.toHaveProperty(
      "img_save_path",
    );
  });

  it("keeps the dedicated visual controls idle when the primary model is visual", async () => {
    const catalog = catalogFixture();
    const current = new SettingsHarness({
      ...agentConfigFixture(catalog, {
        mode: "llm",
        provider: "fixture-a",
        model: "model-a2",
        input: ["text", "image"],
        reasoning: false,
        tools: false,
      }),
      image_recognition: {
        enable: true,
        provider: "fixture-a",
        model: "model-a2",
        apiKey: "",
        baseUrl: "",
        systemPrompt: "只转述图片中的可见内容。",
        prompt: "请转述图片。",
        maxTokens: 160,
        contextWindow: 1_600,
        maxSessions: 8,
        thinkingLevel: "off",
        reasoning: false,
        headers: {},
        samplingParams: {},
      },
    }, catalog);
    harness = current;
    await current.start();

    expect(current.control("image_recognition.enable").checked).toBe(true);
    expect(current.control("image_recognition.model").disabled).toBe(true);
    expect(current.field("image_recognition.model").textContent)
      .toContain("主模型已支持图片输入");
    expect(current.document.element("settings-agent-catalog-state").textContent)
      .toContain("专用视觉模型保持待机");
  });

  it("locks pending platforms while preserving their legacy configuration until a usable adapter is selected", async () => {
    const catalog = catalogFixture();
    const current = new SettingsHarness({
      ...agentConfigFixture(catalog),
      platform: "youtube",
      youtube: { enable: true, api_key: "legacy-key" },
      webui: {
        show_card: {
          common_config: {
            youtube: { enable: true },
          },
        },
      },
    }, catalog);
    harness = current;
    await current.start();

    const platform = current.control("platform");
    expect(platform).toBeInstanceOf(FakeSelectElement);
    expect(platform.children.map(({ value, disabled }) => ({ value, disabled }))).toEqual([
      { value: "talk", disabled: false },
      { value: "bilibili-web", disabled: false },
      { value: "bilibili-platform", disabled: false },
      { value: "youtube", disabled: true },
      { value: "twitch", disabled: true },
      { value: "ordinaryroad_barrage_fly", disabled: true },
    ]);
    expect(current.control("youtube.enable").disabled).toBe(true);
    expect(current.control("youtube.api_key").disabled).toBe(true);
    expect(current.control("webui.show_card.common_config.youtube.enable").disabled).toBe(true);

    platform.value = "bilibili-web";
    platform.dispatch("change");
    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.document.element("settings-connection-label").textContent === "已连接"
        && current.requests.filter(({ path }) => path === "/api/agent/catalog").length === 2,
      "completed platform settings PUT",
    );
    expect(current.puts[0]?.["platform"]).toBe("bilibili-web");
    expect(current.puts[0]?.["youtube"]).toEqual({ enable: true, api_key: "legacy-key" });
    expect(current.control("youtube.enable").disabled).toBe(true);
  });

  it("renders every finite legacy setting as a single-select and preserves unknown values", async () => {
    const catalog = catalogFixture();
    const current = new SettingsHarness({
      ...agentConfigFixture(catalog),
      comment_log_type: "自定义日志",
      visual_body: "其他",
      audio_synthesis_type: "edge-tts",
      play_audio: { player: "pygame" },
      search_online: { provider: "tavily" },
      idle_time_task: { type: "直播间无消息更新闲时" },
      vits: {
        type: "vits",
        lang: "自动",
        gpt_sovits: { lang: "auto", prompt_lang: "auto" },
      },
      bert_vits2: {
        type: "hiyori",
        language: "auto",
        "刘悦-中文特化API": { language: "ZH" },
      },
      openai_tts: {
        type: "api",
        model: "tts-1",
        voice: "nova",
      },
      gpt_sovits: {
        type: "api",
        prompt_language: "日文",
        language: "自动识别",
        cut: "凑四句一切",
        api_0322: {
          prompt_lang: "日文",
          text_lang: "中英混合",
          text_split_method: "按标点符号切",
        },
        api_0706: {
          prompt_language: "中文",
          text_language: "中文",
        },
        v2_api_0821: {
          prompt_lang: "zh",
          text_lang: "zh",
          text_split_method: "cut0",
        },
        webtts: {
          version: "1",
          lang: "zh",
        },
      },
      webui: {
        log: { log_level: "INFO" },
        theme: {
          choose: "蓝天白云",
          list: {
            "默认黑白": {},
            "蓝天白云": {},
          },
        },
      },
    }, catalog);
    harness = current;
    await current.start();

    const fixedChoicePaths = [
      "comment_log_type",
      "visual_body",
      "audio_synthesis_type",
      "play_audio.player",
      "search_online.provider",
      "idle_time_task.type",
      "vits.type",
      "vits.lang",
      "bert_vits2.type",
      "bert_vits2.language",
      "openai_tts.type",
      "openai_tts.model",
      "openai_tts.voice",
      "gpt_sovits.type",
      "gpt_sovits.prompt_language",
      "gpt_sovits.language",
      "gpt_sovits.cut",
      "gpt_sovits.api_0322.prompt_lang",
      "gpt_sovits.api_0322.text_lang",
      "gpt_sovits.api_0322.text_split_method",
      "gpt_sovits.api_0706.prompt_language",
      "gpt_sovits.api_0706.text_language",
      "gpt_sovits.v2_api_0821.prompt_lang",
      "gpt_sovits.v2_api_0821.text_lang",
      "gpt_sovits.v2_api_0821.text_split_method",
      "gpt_sovits.webtts.version",
      "gpt_sovits.webtts.lang",
      "webui.log.log_level",
      "webui.theme.choose",
    ];
    for (const path of fixedChoicePaths) {
      expect(current.control(path), path).toBeInstanceOf(FakeSelectElement);
    }

    expect(
      current.control("audio_synthesis_type").children.map(({ value }) => value),
    ).toEqual([
      "none",
      "edge-tts",
      "azure_tts",
      "openai_tts",
      "vits",
      "bert_vits2",
      "gpt_sovits",
    ]);
    expect(current.control("visual_body").children.map(({ value }) => value))
      .toEqual(["其他", "live2d", "EasyAIVtuber"]);
    expect(current.control("gpt_sovits.type").children.map(({ value }) => value))
      .toEqual([
        "api",
        "api_0322",
        "gradio_0322",
        "api_0706",
        "v2_api_0821",
        "webtts",
      ]);
    expect(current.control("webui.theme.choose").children.map(({ value }) => value))
      .toEqual(["默认黑白", "蓝天白云"]);

    const commentLog = current.control("comment_log_type");
    expect(commentLog.value).toBe("自定义日志");
    expect(commentLog.children[0]?.textContent).toContain("当前配置，未识别");
    commentLog.value = "问答";
    commentLog.dispatch("change");
    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.document.element("settings-connection-label").textContent === "已连接"
        && current.requests.filter(({ path }) => path === "/api/agent/catalog").length === 2,
      "completed finite-choice settings PUT",
    );
    expect(current.puts[0]?.["comment_log_type"]).toBe("问答");
    expect(
      ((current.puts[0]?.["webui"] as Record<string, unknown>)["theme"] as
        Record<string, unknown>)["choose"],
    ).toBe("蓝天白云");
  });

  it("synchronizes Edge TTS voices into a single-select and persists the speaker", async () => {
    const catalog = catalogFixture();
    const current = new SettingsHarness({
      ...agentConfigFixture(catalog),
      "edge-tts": {
        voice: "zh-CN-XiaoyiNeural",
        rate: "+0%",
        volume: "+0%",
        proxy: "",
      },
    }, catalog);
    harness = current;
    await current.start();

    const voice = current.control("edge-tts.voice");
    expect(voice).toBeInstanceOf(FakeSelectElement);
    expect(voice.children.map(({ value }) => value)).toEqual([
      "en-US-AvaNeural",
      "zh-CN-XiaoyiNeural",
    ]);
    expect(voice.value).toBe("zh-CN-XiaoyiNeural");
    expect(current.field("edge-tts.voice").querySelector(".settings-field-help")?.textContent)
      .toContain("已自动同步 2 个 Edge TTS 语音");
    expect(current.requests.map(({ path }) => path)).toContain(
      "/api/speech/edge/voices",
    );

    voice.value = "en-US-AvaNeural";
    voice.dispatch("change");
    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.document.element("settings-connection-label").textContent === "已连接"
        && current.requests.filter(({ path }) => path === "/api/agent/catalog").length === 2,
      "completed Edge voice settings PUT",
    );
    expect(

      (current.puts[0]?.["edge-tts"] as Record<string, unknown>)["voice"],
    ).toBe("en-US-AvaNeural");
  });
  it("keeps historical settings visible but read-only, including server-protected Live2D binding", async () => {
    const catalog = catalogFixture();
    const current = new SettingsHarness({
      ...agentConfigFixture(catalog),
      gpt_sovits: { gpt_model_path: "legacy-gpt.ckpt", sovits_model_path: "legacy-vits.pth" },
      vits: { gpt_sovits: { reference_audio: "legacy.wav" } },
      bert_vits2: { "刘悦-中文特化API": { speaker: "legacy" } },
      webui: { title: "旧面板", auto_run: true, show_card: { common_config: {} } },
      live2d: { host: "127.0.0.1", port: 12345 },
    }, catalog);
    current.readOnlyPaths = [["live2d", "host"], ["live2d", "port"]];
    harness = current;
    await current.start();

    for (const path of [
      "gpt_sovits.gpt_model_path",
      "gpt_sovits.sovits_model_path",
      "vits.gpt_sovits.reference_audio",
      "bert_vits2.刘悦-中文特化API.speaker",
      "webui.title",
      "webui.auto_run",
      "live2d.host",
      "live2d.port",
    ]) {
      expect(current.control(path).disabled || current.control(path).readOnly, path).toBe(true);
    }
    expect(current.field("gpt_sovits.gpt_model_path").textContent).toContain("不会生效");
  });

  it("saves unrelated edits with retained invalid Agent settings outside LLM mode", async () => {
    const catalog = catalogFixture();
    const current = new SettingsHarness({
      agent: {
        ...(agentConfigFixture(catalog)["agent"] as Record<string, unknown>),
        mode: "reread",
        provider: "retained-but-unavailable",
        model: "retained-model",
      },
      captions: { enable: false },
    }, catalog);
    current.putFailure = {
      status: 409,
      payload: {
        error: {
          code: "operator_bind_restart_required",
          message: "operator bind restart required",
        },
      },
    };
    harness = current;
    await current.start();

    const captions = current.control("captions.enable");
    captions.checked = true;
    captions.dispatch("change");
    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.document.element("settings-announcement").textContent.includes("本机配置后重启"),
      "settings PUT bind-restart response despite retained Agent values",
    );

    expect(current.document.element("settings-revision").textContent).toBe("修订：4");
    expect(current.document.element("settings-dirty-count").dataset["dirty"]).toBe("true");
    expect(current.document.element("settings-announcement").textContent).toContain("本机配置后重启");
    expect(current.document.element("settings-announcement").textContent).not.toContain("版本冲突");
  });

  it("blocks enabled idle work without an executable prompt at its precise field", async () => {
    const catalog = catalogFixture();
    const current = new SettingsHarness({
      ...agentConfigFixture(catalog),
      captions: { enable: false },
      idle_time_task: {
        enable: true,
        type: "直播间无消息更新闲时",
        idle_time_min: 1,
        idle_time_max: 2,
        idle_time_reduce_to: 0,
        wait_play_audio_num_threshold: 0,
        min_msg_queue_len_to_trigger: 0,
        min_audio_queue_len_to_trigger: 0,
        trigger_type: [],
        copywriting: { enable: true, random: false, copy: [] },
        comment: { enable: false },
      },
    }, catalog);
    harness = current;
    await current.start();

    const captions = current.control("captions.enable");
    captions.checked = true;
    captions.dispatch("change");
    current.document.element("settings-form").dispatch("submit");

    expect(current.puts).toHaveLength(0);
    expect(current.field("idle_time_task.copywriting.copy").textContent).toContain(
      "至少需要一条非空提示",
    );
  });

  it("links catalog controls, exposes credential draft state, and saves the complete config", async () => {
    const current = new SettingsHarness();
    harness = current;
    await current.start();

    expect(current.document.element("settings-tree").children[0]?.dataset["category"]).toBe("agent");
    expect(current.document.element("settings-agent-source").textContent).toContain("根 agent");
    expect(current.document.element("settings-dirty-count").textContent).toBe("0 项待处理");
    const removedCategory = current.document.element("settings-tree").children
      .find(({ dataset }) => dataset["category"] === "legacy-llm");
    expect(removedCategory).toBeUndefined();
    expect(current.control("agent.mode").children.map(({ value }) => value)).toEqual([
      "llm",
      "reread",
      "disabled",
    ]);

    const provider = current.control("agent.provider");
    expect(provider).toBeInstanceOf(FakeSelectElement);
    expect(provider.children.map(({ value }) => value)).toEqual([
      "fixture-a",
      "fixture-b",
      "openai-compatible",
    ]);
    const initialModel = current.control("agent.model");
    expect(initialModel.children.map(({ value }) => value)).toEqual(["model-a", "model-a2"]);

    initialModel.value = "model-a2";
    initialModel.dispatch("change");
    expect(current.control("agent.maxTokens").value).toBe("160");
    expect(current.control("agent.contextWindow").value).toBe("1600");

    const changedProvider = current.control("agent.provider");
    changedProvider.value = "fixture-b";
    changedProvider.dispatch("change");
    expect(current.control("agent.model").value).toBe("model-b");
    expect(current.control("agent.maxTokens").value).toBe("320");
    expect(current.control("agent.input").checked).toBe(true);
    expect(current.control("agent.tools").checked).toBe(true);
    expect(current.document.element("settings-agent-credential").textContent).toBe("待保存校验");

    const compatibleProvider = current.control("agent.provider");
    compatibleProvider.value = "openai-compatible";
    compatibleProvider.dispatch("change");
    const customModel = current.control("agent.model");
    expect(customModel).toBeInstanceOf(FakeInputElement);
    expect(current.field("agent.model").querySelector(".settings-field-meta")?.textContent)
      .not.toContain("自定义模型 ID");
    expect(current.field("agent.model").textContent).not.toContain("目录选择");
    customModel.value = "fixture-deployment";
    customModel.dispatch("input");
    const baseUrl = current.control("agent.baseUrl");
    expect(current.field("agent.baseUrl").dataset["agentAttention"]).toBe("true");
    baseUrl.value = "https://fixture.invalid/v1";
    baseUrl.dispatch("input");

    const mode = current.control("agent.mode");
    mode.value = "reread";
    mode.dispatch("change");
    expect(current.control("agent.provider").disabled).toBe(true);
    expect(current.control("agent.baseUrl").disabled).toBe(true);
    mode.value = "llm";
    mode.dispatch("change");
    expect(current.control("agent.provider").disabled).toBe(false);

    const apiKey = current.control("agent.apiKey");
    expect(apiKey.type).toBe("password");
    apiKey.value = "fixture-secret-not-for-status";
    apiKey.dispatch("input");
    expect(current.document.element("settings-agent-credential").textContent).toBe(
      "新凭据已填写，待保存校验",
    );
    expect([
      current.document.element("settings-agent-source").textContent,
      current.document.element("settings-agent-route").textContent,
      current.document.element("settings-agent-selection").textContent,
      current.document.element("settings-agent-capability").textContent,
      current.document.element("settings-agent-credential").textContent,
      current.document.element("settings-agent-catalog-state").textContent,
    ].join(" ")).not.toContain("fixture-secret-not-for-status");

    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.document.element("settings-connection-label").textContent === "已连接"
        && current.requests.filter(({ path }) => path === "/api/agent/catalog").length === 2,
      "completed settings PUT and catalog refresh",
    );
    const saved = current.puts[0]!;
    const agent = saved["agent"] as Record<string, unknown>;
    expect(Object.keys(agent)).toEqual([
      "mode",
      "provider",
      "model",
      "apiKey",
      "baseUrl",
      "systemPrompt",
      "maxTokens",
      "contextWindow",
      "maxSessions",
      "thinkingLevel",
      "reasoning",
      "input",
      "tools",
      "headers",
      "samplingParams",
    ]);
    expect(agent).toMatchObject({
      mode: "llm",
      provider: "openai-compatible",
      model: "fixture-deployment",
      apiKey: "fixture-secret-not-for-status",
      baseUrl: "https://fixture.invalid/v1",
      maxTokens: 320,
      contextWindow: 3_200,
      reasoning: false,
      input: ["text", "image"],
      tools: true,
    });
    const putRequest = current.requests.find(({ init }) => init?.method === "PUT");
    expect(new Headers(putRequest?.init?.headers).get("If-Match")).toBe('"4"');
    expect(current.document.element("settings-agent-credential").textContent).toBe(
      "已配置（内容保持隐藏）",
    );
  });

  it("trusts catalog authority for an unchanged redacted marker", async () => {
    const catalog = {
      ...catalogFixture("agent"),
      apiKeyConfigured: false,
    };
    const current = new SettingsHarness(agentConfigFixture(catalog), catalog);
    harness = current;
    await current.start();

    expect(current.document.element("settings-agent-credential").textContent).toBe(
      "尚未配置，可使用环境变量或下方密钥字段",
    );
    expect(current.document.element("settings-agent-credential").textContent).not.toContain(
      "[REDACTED]",
    );
    const headers = current.control("agent.headers");
    headers.value = '{"Authorization":"Bearer fixture"}';
    headers.dispatch("input");
    expect(current.document.element("settings-agent-credential").textContent).toBe("待保存校验");
    expect(current.document.element("settings-reset").disabled).toBe(false);
    current.document.element("settings-reset").dispatch("click");
    expect(current.control("agent.headers").value).toBe("{}");
    expect(current.document.element("settings-agent-credential").textContent).toBe(
      "尚未配置，可使用环境变量或下方密钥字段",
    );

    const systemPrompt = current.control("agent.systemPrompt");
    systemPrompt.value = "changed prompt";
    systemPrompt.dispatch("input");
    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.requests.filter(({ path }) => path === "/api/agent/catalog").length === 2,
      "redacted settings save and catalog refresh",
    );
    expect((current.puts[0]?.["agent"] as Record<string, unknown>)["apiKey"]).toBe("[REDACTED]");
    expect(current.document.element("settings-agent-credential").textContent).toBe(
      "尚未配置，可使用环境变量或下方密钥字段",
    );
  });

  it("allows only one in-flight save and ignores repeated or disabled save shortcuts", async () => {
    const catalog = catalogFixture("agent");
    const current = new SettingsHarness(agentConfigFixture(catalog), catalog);
    harness = current;
    await current.start();
    const systemPrompt = current.control("agent.systemPrompt");
    systemPrompt.value = "changed prompt";
    systemPrompt.dispatch("input");
    const releasePut = current.deferPutResponse();

    current.document.element("settings-form").dispatch("submit");
    current.document.element("settings-form").dispatch("submit");
    const disabledShortcut = current.document.dispatch("keydown", { ctrlKey: true, key: "s" });
    const repeatedShortcut = current.document.dispatch("keydown", {
      key: "s",
      metaKey: true,
      repeat: true,
    });
    expect(disabledShortcut.defaultPrevented).toBe(true);
    expect(repeatedShortcut.defaultPrevented).toBe(true);
    expect(current.puts).toHaveLength(1);

    releasePut();
    await waitUntil(
      () => current.document.element("settings-revision").textContent === "修订：5"
        && current.document.element("settings-save").disabled,
      "single settings save",
    );
    const noChangesShortcut = current.document.dispatch("keydown", { ctrlKey: true, key: "s" });
    expect(noChangesShortcut.defaultPrevented).toBe(true);
    expect(current.puts).toHaveLength(1);
  });

  it("preserves unparsed input across catalog redraws and globally restores loaded model bindings", async () => {
    const catalog = catalogFixture("agent");
    const current = new SettingsHarness(agentConfigFixture(catalog), catalog);
    harness = current;
    await current.start();

    const headers = current.control("agent.headers");
    headers.value = "{ invalid";
    headers.dispatch("input");
    expect(current.field("agent.headers").querySelector(".settings-field-error")?.textContent)
      .toContain("JSON 格式错误");

    const model = current.control("agent.model");
    model.value = "model-a2";
    model.dispatch("change");
    expect(current.control("agent.headers").value).toBe("{ invalid");
    expect(current.field("agent.headers").querySelector(".settings-field-error")?.textContent)
      .toContain("JSON 格式错误");
    expect(current.control("agent.model").focusCalls).toBeGreaterThan(0);
    expect(current.control("agent.maxTokens").value).toBe("160");
    expect(current.control("agent.contextWindow").value).toBe("1600");
    expect(current.control("agent.reasoning").checked).toBe(false);
    expect(current.control("agent.input").checked).toBe(true);
    expect(current.control("agent.tools").checked).toBe(false);

    const provider = current.control("agent.provider");
    provider.value = "fixture-b";
    provider.dispatch("change");
    expect(current.control("agent.provider").value).toBe("fixture-b");
    expect(current.control("agent.model").value).toBe("model-b");
    expect(current.control("agent.maxTokens").value).toBe("320");
    expect(current.control("agent.contextWindow").value).toBe("3200");
    expect(current.control("agent.reasoning").checked).toBe(false);
    expect(current.control("agent.input").checked).toBe(true);
    expect(current.control("agent.tools").checked).toBe(true);
    expect(current.control("agent.headers").value).toBe("{ invalid");
    expect(current.field("agent.headers").querySelector(".settings-field-error")?.textContent)
      .toContain("JSON 格式错误");

    const invalidProvider = current.control("agent.provider");
    invalidProvider.value = "missing-provider";
    invalidProvider.dispatch("change");
    expect(current.document.element("settings-agent-selection").textContent).toBe(
      "Fixture B / Model B",
    );
    expect(current.field("agent.provider").querySelector(".settings-field-error")?.textContent)
      .toContain("不在模型目录");
    expect(current.control("agent.headers").value).toBe("{ invalid");
    expect(current.document.element("settings-agent-catalog-state").textContent)
      .toContain("模型供应商");
    expect(renderedAndAccessibleText(current.document)).not.toContain("$.agent.provider");

    expect(current.document.element("settings-reset").disabled).toBe(false);
    current.document.element("settings-reset").dispatch("click");
    expect(current.control("agent.provider").value).toBe("fixture-a");
    expect(current.control("agent.model").value).toBe("model-a");
    expect(current.control("agent.maxTokens").value).toBe("80");
    expect(current.control("agent.contextWindow").value).toBe("800");
    expect(current.control("agent.reasoning").checked).toBe(true);
    expect(current.control("agent.input").checked).toBe(false);
    expect(current.control("agent.tools").checked).toBe(true);
    expect(current.control("agent.headers").value).toBe("{}");
    expect(current.field("agent.headers").querySelector(".settings-field-error")?.textContent)
      .toBe("");
    expect(current.document.element("settings-agent-selection").textContent).toBe(
      "Fixture A / Model A",
    );
    expect(current.document.element("settings-dirty-count").textContent).toBe("0 项待处理");
    expect(current.document.element("settings-reset").disabled).toBe(true);
  });

  it("validates canonical Agent fields locally before PUT", async () => {
    const catalog = catalogFixture("agent");
    const current = new SettingsHarness(agentConfigFixture(catalog), catalog);
    harness = current;
    await current.start();

    for (const field of ["maxTokens", "contextWindow", "maxSessions"]) {
      const control = current.control(`agent.${field}`);
      control.value = field === "contextWindow" ? "1.5" : "0";
      control.dispatch("input");
      expect(current.field(`agent.${field}`).querySelector(".settings-field-error")?.textContent)
        .toContain("大于 0 的整数");
    }
    const samplingParams = current.control("agent.samplingParams");
    samplingParams.value = '{"temperature":0.4}';
    samplingParams.dispatch("input");
    expect(current.field("agent.samplingParams").querySelector(".settings-field-error")?.textContent)
      .toContain("默认温度");

    const input = current.control("agent.input");
    input.checked = true;
    input.dispatch("change");
    expect(current.field("agent.input").querySelector(".settings-field-error")?.textContent)
      .toContain("不支持视觉能力");
    const headers = current.control("agent.headers");
    headers.value = '{"Bad Header":"ok","X-Test":2}';
    headers.dispatch("input");
    expect(current.field("agent.headers").querySelector(".settings-field-error")?.textContent)
      .toContain("字符串");

    const baseUrl = current.control("agent.baseUrl");
    baseUrl.value = "https://user:pass@fixture.invalid/v1?key=value#fragment";
    baseUrl.dispatch("input");
    expect(current.field("agent.baseUrl").querySelector(".settings-field-error")?.textContent)
      .toContain("绝对 http(s) URL");

    const provider = current.control("agent.provider");
    provider.value = "openai-compatible";
    provider.dispatch("change");
    const customModel = current.control("agent.model");
    customModel.value = "";
    customModel.dispatch("input");
    const requiredBaseUrl = current.control("agent.baseUrl");
    requiredBaseUrl.value = "";
    requiredBaseUrl.dispatch("input");
    expect(current.field("agent.model").querySelector(".settings-field-error")?.textContent)
      .toContain("必须填写 model ID");
    expect(current.field("agent.baseUrl").querySelector(".settings-field-error")?.textContent)
      .toContain("必须填写 Base URL");

    current.document.element("settings-form").dispatch("submit");
    expect(current.puts).toHaveLength(0);
    expect(current.document.element("settings-announcement").textContent).toContain(
      "请先修正标记为错误的字段",
    );
    expect(current.control("agent.model").focusCalls).toBeGreaterThan(0);
  });

  it("keeps invalid_agent_config in the Agent status and focuses its mapped field", async () => {
    const catalog = catalogFixture("agent");
    const current = new SettingsHarness(agentConfigFixture(catalog), catalog);
    current.putFailure = {
      status: 422,
      payload: {
        error: {
          code: "invalid_agent_config",
          message: "修改 agent.provider 或 agent.baseUrl 时必须重新输入凭据，不能复用脱敏占位符",
        },
      },
    };
    harness = current;
    await current.start();
    const systemPrompt = current.control("agent.systemPrompt");
    systemPrompt.value = "changed prompt";
    systemPrompt.dispatch("input");

    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.document.element("settings-agent-catalog-state").textContent
        .includes("必须重新输入凭据"),
      "persistent Agent validation error",
    );
    expect(current.document.element("settings-agent-catalog-state").dataset["tone"]).toBe("error");
    expect(current.control("agent.apiKey").focusCalls).toBeGreaterThan(0);
    expect(current.field("agent.apiKey").querySelector(".settings-field-error")?.textContent)
      .toContain("重新输入凭据");
    expect(current.requests.filter(({ path }) => path === "/api/agent/catalog")).toHaveLength(1);
  });

  it("keeps a successful save when the authoritative catalog refresh fails", async () => {
    const catalog = catalogFixture("agent");
    const current = new SettingsHarness(agentConfigFixture(catalog), catalog);
    current.failCatalogRefresh = true;
    harness = current;
    await current.start();
    const systemPrompt = current.control("agent.systemPrompt");
    systemPrompt.value = "changed prompt";
    systemPrompt.dispatch("input");

    current.document.element("settings-form").dispatch("submit");
    await waitUntil(
      () => current.document.element("settings-connection-label").textContent === "已保存",
      "saved config with failed catalog refresh",
    );
    expect(current.document.element("settings-revision").textContent).toBe("修订：5");
    expect(current.document.element("settings-dirty-count").textContent).toBe("0 项待处理");
    expect(current.document.element("settings-announcement").dataset["tone"]).toBe("warning");
    expect(current.document.element("settings-announcement").textContent).toContain("配置已保存");
    expect(current.document.element("settings-announcement").textContent).not.toContain("保存失败");
    expect(current.document.element("settings-agent-credential").textContent).toBe(
      "配置已保存，凭据状态待目录刷新",
    );
    expect(current.document.element("settings-agent-catalog-state").textContent).toContain(
      "配置已保存，但 Pi 模型目录刷新失败",
    );
    expect(current.puts).toHaveLength(1);
  });
});
