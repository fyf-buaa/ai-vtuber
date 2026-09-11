import { afterEach, describe, expect, it, vi } from "vitest";

const ELEMENT_IDS = [
  "auth-form",
  "token-input",
  "connect-button",
  "connection-mark",
  "connection-label",
  "connection-detail",
  "announcement",
  "refresh-status",
  "reload-runtime",
  "stop-runtime",
  "manual-form",
  "event-type",
  "event-username",
  "event-content",
  "content-count",
  "send-event",
  "manual-result",
  "event-log",
  "log-empty",
  "log-count",
  "pause-log",
  "clear-log",
  "config-editor",
  "config-validation",
  "config-revision",
  "load-config",
  "save-config",
  "footer-time",
  "runtime-dot",
  "runtime-state",
  "agent-dot",
  "agent-state",
  "speech-dot",
  "speech-state",
  "stream-dot",
  "stream-state",
  "event-queue",
  "speech-queue",
  "playback-queue",
  "avatar-stage",
  "avatar-preview",
  "avatar-placeholder",
  "avatar-preview-title",
  "avatar-preview-detail",
  "avatar-model-name",
  "avatar-camera-status",
  "avatar-camera-state",
  "avatar-camera-detail",
  "start-avatar-camera",
  "stop-avatar-camera",
  "avatar-talk-form",
  "avatar-talk-content",
  "avatar-talk-result",
  "send-avatar-talk",
] as const;

interface FakeEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

type FakeListener = (event: FakeEvent) => void;

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, FakeListener[]>();
  parent: FakeElement | undefined;
  textContent = "";
  value = "";
  className = "";
  dateTime = "";
  hidden = false;
  disabled = false;
  scrollTop = 0;
  selectionStart = 0;
  selectionEnd = 0;

  constructor(readonly id = "") {}

  get scrollHeight(): number {
    return this.children.length;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Partial<Omit<FakeEvent, "preventDefault">> = {}): void {
    const payload: FakeEvent = {
      key: event.key ?? "",
      ctrlKey: event.ctrlKey ?? false,
      metaKey: event.metaKey ?? false,
      preventDefault() {},
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) {
      child.parent = undefined;
    }
    this.children.length = 0;
    this.append(...children);
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (selector === `.${child.className}`) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  remove(): void {
    if (this.parent === undefined) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = undefined;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  focus(): void {}

  setRangeText(replacement: string, start: number, end: number): void {
    this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
    this.selectionStart = start + replacement.length;
    this.selectionEnd = this.selectionStart;
  }
}

class FakeDocument {
  readonly visibilityState = "visible";
  readonly listeners = new Map<string, FakeListener[]>();
  readonly elements: Partial<Record<string, FakeElement>> = {};

  constructor() {
    for (const id of ELEMENT_IDS) {
      this.elements[id] = new FakeElement(id);
    }
    this.element("event-log").append(this.element("log-empty"));
  }

  element(id: string): FakeElement {
    const found = this.elements[id];
    if (found === undefined) {
      throw new Error(`Missing fake element #${id}`);
    }
    return found;
  }

  getElementById(id: string): FakeElement | null {
    return this.elements[id] ?? null;
  }

  createElement(): FakeElement {
    return new FakeElement();
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    const event: FakeEvent = {
      key: "",
      ctrlKey: false,
      metaKey: false,
      preventDefault() {},
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeWindow {
  readonly listeners = new Map<string, Array<() => void>>();
  #nextTimer = 1;

  setInterval(): number {
    return this.#nextTimer++;
  }

  clearInterval(): void {}

  setTimeout(): number {
    return this.#nextTimer++;
  }

  clearTimeout(): void {}

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Deferred promise was not initialized");
  }
  return { promise, resolve: resolvePromise };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitUntil(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const HEALTHY_STATUS = {
  runtime: {
    state: "running",
    agent: { state: "active" },
    queue: { pending: 7 },
  },
  speech: { state: "running", queued: 3 },
  playback: { waitPlayAudio: 2 },
};

class WebClientHarness {
  readonly document = new FakeDocument();
  readonly window = new FakeWindow();
  readonly storage = new FakeStorage();
  readonly statusResponses: Array<Response | Promise<Response>> = [jsonResponse(HEALTHY_STATUS)];
  readonly statusSignals: AbortSignal[] = [];
  statusCalls = 0;
  streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  configPutResponse: Response | undefined;

  readonly fetch = vi.fn(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (path === "/api/status") {
      this.statusCalls += 1;
      if (init?.signal === undefined || init.signal === null) {
        throw new Error("Status request is missing an abort signal");
      }
      this.statusSignals.push(init.signal);
      const response = this.statusResponses.shift();
      if (response === undefined) {
        throw new Error("No queued status response");
      }
      return await response;
    }
    if (path === "/api/config") {
      if (init?.method === "PUT" && this.configPutResponse !== undefined) {
        return this.configPutResponse;
      }
      return jsonResponse({ config: {}, revision: 0 });
    }
    if (path === "/api/avatar") {
      return jsonResponse({ enabled: false, previewUrl: null });
    }
    if (path === "/api/events") {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.streamController = controller;
        },
      });
      return new Response(body, { status: 200 });
    }
    throw new Error(`Unexpected request ${path}`);
  });

  async start(): Promise<void> {
    vi.stubGlobal("document", this.document as unknown as Document);
    vi.stubGlobal("window", this.window as unknown as Window & typeof globalThis);
    vi.stubGlobal("sessionStorage", this.storage as unknown as Storage);
    vi.stubGlobal("fetch", this.fetch);
    // The client initializes from browser globals at module evaluation, so they must be installed first.
    await import("../web/client.js");
    await waitUntil(() => this.streamController !== undefined, "initial web-client connection");
  }

  enqueueStatus(response: Response | Promise<Response>): void {
    this.statusResponses.push(response);
  }

  logEntries(): FakeElement[] {
    return this.document.element("event-log").children.filter((child) => child.className === "log-entry");
  }

  emitEvents(events: readonly unknown[]): void {
    if (this.streamController === undefined) {
      throw new Error("Event stream is not connected");
    }
    const frames = events
      .map((event) => `event: app-event\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    this.streamController.enqueue(new TextEncoder().encode(frames));
  }

  async dispose(): Promise<void> {
    this.window.dispatch("beforeunload");
    this.streamController?.close();
    await settleAsyncWork();
  }
}

let harness: WebClientHarness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("web client safety", () => {
  it("clamps huge finite event timestamps without interrupting later events", async () => {
    harness = new WebClientHarness();
    await harness.start();

    harness.emitEvents([
      {
        type: "system.status",
        component: "runtime.scheduler",
        status: "degraded",
        message: "scheduler delayed",
        timestamp: Number.MAX_VALUE,
      },
      {
        type: "agent.completed",
        response: { text: "completed" },
        timestamp: -Number.MAX_VALUE,
      },
      {
        type: "inbound",
        event: { username: "viewer", content: "still connected" },
        timestamp: 0,
      },
    ]);

    await waitUntil(() => harness?.logEntries().length === 3, "all streamed events to render");
    const entries = harness.logEntries();
    expect(entries[0]?.children[0]?.dateTime).toBe("+275760-09-13T00:00:00.000Z");
    expect(entries[1]?.children[0]?.dateTime).toBe("-271821-04-20T00:00:00.000Z");
    expect(entries[2]?.children[2]?.textContent).toContain("still connected");
  });

  it("keeps the newest status when overlapping refreshes resolve out of order", async () => {
    harness = new WebClientHarness();
    await harness.start();
    const older = deferred<Response>();
    const newer = deferred<Response>();
    harness.enqueueStatus(older.promise);
    harness.enqueueStatus(newer.promise);

    harness.document.dispatch("visibilitychange");
    harness.document.dispatch("visibilitychange");
    await waitUntil(() => harness?.statusCalls === 3, "both overlapping status requests");
    expect(harness.statusSignals).toHaveLength(3);
    expect(harness.statusSignals[1]?.aborted).toBe(true);
    expect(harness.statusSignals[2]?.aborted).toBe(false);

    newer.resolve(jsonResponse({
      runtime: {
        state: "running",
        agent: { state: "active" },
        queue: { pending: 22 },
      },
      speech: { state: "running", queued: 33 },
      playback: { waitPlayAudio: 44 },
    }));
    await waitUntil(
      () => harness?.document.element("event-queue").textContent === "22",
      "newer status response",
    );

    older.resolve(jsonResponse({
      runtime: {
        state: "stopped",
        agent: { state: "stopped" },
        queue: { pending: 1 },
      },
      speech: { state: "stopped", queued: 1 },
      playback: { waitPlayAudio: 1 },
    }));
    await settleAsyncWork();

    expect(harness.document.element("runtime-state").textContent).toBe("运行中");
    expect(harness.document.element("agent-state").textContent).toBe("工作中");
    expect(harness.document.element("speech-state").textContent).toBe("运行中");
    expect(harness.document.element("event-queue").textContent).toBe("22");
    expect(harness.document.element("speech-queue").textContent).toBe("33");
    expect(harness.document.element("playback-queue").textContent).toBe("44");
  });

  it("clears every runtime-dependent field when a status refresh fails", async () => {
    harness = new WebClientHarness();
    await harness.start();
    expect(harness.document.element("event-queue").textContent).toBe("7");
    expect(harness.document.element("speech-queue").textContent).toBe("3");
    expect(harness.document.element("playback-queue").textContent).toBe("2");
    harness.enqueueStatus(jsonResponse({
      error: { code: "UNAVAILABLE", message: "service unavailable" },
    }, 503));

    harness.document.element("refresh-status").dispatch("click");
    await waitUntil(
      () => harness?.document.element("connection-label").textContent === "连接失败",
      "failed status response",
    );

    for (const component of ["runtime", "agent", "speech"] as const) {
      expect(harness.document.element(`${component}-dot`).dataset.state).toBe("error");
      expect(harness.document.element(`${component}-state`).textContent).toBe("离线");
    }
    expect(harness.document.element("event-queue").textContent).toBe("—");
    expect(harness.document.element("speech-queue").textContent).toBe("—");
    expect(harness.document.element("playback-queue").textContent).toBe("—");
  });

  it("presents degraded system status events with a warning tone", async () => {
    harness = new WebClientHarness();
    await harness.start();

    harness.emitEvents([{
      type: "system.status",
      component: "output.live2d",
      status: "degraded",
      message: "output delayed",
      timestamp: Date.now(),
    }]);

    await waitUntil(() => harness?.logEntries().length === 1, "degraded status event");
    expect(harness.logEntries()[0]?.dataset.tone).toBe("warning");
  });
  it("preserves the advanced editor revision for a bind-restart response", async () => {
    harness = new WebClientHarness();
    harness.configPutResponse = jsonResponse({
      error: {
        code: "operator_bind_restart_required",
        message: "operator bind restart required",
      },
    }, 409);
    await harness.start();
    await waitUntil(
      () => harness?.document.element("config-revision").textContent === "修订 0",
      "loaded advanced config revision",
    );
    harness.document.element("config-editor").value = '{"captions":{"enable":true}}';
    harness.document.element("save-config").dispatch("click");
    await waitUntil(
      () => harness?.document.element("config-validation").textContent.includes("本机配置后重启") === true,
      "bind restart validation",
    );

    expect(harness.document.element("config-revision").textContent).toBe("修订 0");
    expect(harness.document.element("config-editor").value).toBe('{"captions":{"enable":true}}');
  });

});
