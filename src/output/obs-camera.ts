import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";

export interface ObsCameraConfig {
  readonly url?: string | undefined;
  readonly password?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly fps?: number | undefined;
}

export interface ObsCameraStatus {
  readonly state: "stopped" | "starting" | "running" | "stopping" | "error";
  readonly connected: boolean;
  readonly deviceName: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly sceneName: string;
  readonly error?: string | undefined;
}

const DEFAULT_URL = "ws://127.0.0.1:4455";
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;
const SCENE_NAME = "AI Vtuber Live2D";
const SOURCE_NAME = "AI Vtuber Live2D Browser";
const OWNER_MARKER = "ai-vtuber-live2d-v1";
const REQUEST_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_PENDING_REQUESTS = 32;

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  readonly resolve: (value: JsonObject) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface SavedState {
  readonly programScene: string;
  readonly video: JsonObject;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

function abortError(): Error {
  const error = new Error("OBS virtual camera start was aborted");
  error.name = "AbortError";
  return error;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OBS returned an invalid ${field}`);
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return result;
}

function validateUrl(value: string | undefined): string {
  const raw = value ?? DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OBS WebSocket URL must be a valid loopback ws:// or wss:// URL");
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:")
    || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0
    || !isLoopbackHost(url.hostname)) {
    throw new Error("OBS WebSocket URL must be a loopback ws:// or wss:// URL without credentials, query, or fragment");
  }
  return url.toString();
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1"
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

function authResponse(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(`${password}${salt}`).digest("base64");
  return createHash("sha256").update(`${secret}${challenge}`).digest("base64");
}
function textPayload(data: RawData): string {
  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (Array.isArray(data)) {
    let bytes = 0;
    for (const part of data) {
      bytes += part.byteLength;
      if (bytes > MAX_MESSAGE_BYTES) {
        throw new Error("OBS sent an oversized WebSocket payload");
      }
    }
    buffer = Buffer.concat(data, bytes);
  } else {
    buffer = Buffer.from(data);
  }
  if (buffer.byteLength > MAX_MESSAGE_BYTES) {
    throw new Error("OBS sent an oversized WebSocket payload");
  }
  return buffer.toString("utf8");
}


/** A deliberately small OBS WebSocket v5 client: one socket, bounded requests, no reconnects. */
class ObsConnection {
  private socket: WebSocket | undefined;
  private identified = false;
  private readonly pending = new Map<string, PendingRequest>();
  private identifyResolve: (() => void) | undefined;
  private identifyReject: ((reason: Error) => void) | undefined;
  private identifyTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private requestNumber = 0;

  constructor(
    private readonly url: string,
    private readonly password: string | undefined,
    private readonly onEvent: (type: string, data: JsonObject) => void,
    private readonly onDisconnect: (reason: Error) => void,
  ) {}

  get connected(): boolean {
    return this.identified && this.socket?.readyState === WebSocket.OPEN && !this.closed;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    const identified = this.identify(signal);
    const socket = new WebSocket(this.url, "obswebsocket.json", { maxPayload: MAX_MESSAGE_BYTES });
    this.socket = socket;
    const connected = Promise.withResolvers<void>();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      this.close(error);
      connected.reject(error);
    };
    const onError = (error: Error): void => {
      if (settled) {
        this.close(new Error(`OBS WebSocket error: ${error.message}`));
      } else {
        fail(new Error(`Unable to connect to OBS WebSocket: ${error.message}`));
      }
    };
    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      connected.resolve();
    };
    const onAbort = (): void => fail(abortError());
    socket.on("error", onError);
    socket.once("open", onOpen);
    socket.on("message", (data, isBinary) => this.receive(data, isBinary));
    socket.on("close", () => this.close(new Error("OBS WebSocket disconnected")));
    timer = setTimeout(() => fail(new Error("Timed out connecting to OBS WebSocket")), CONNECT_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await connected.promise;
      await identified;
    } catch (error) {
      await identified.catch(() => undefined);
      throw error;
    }
  }

  private async identify(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    const deferred = Promise.withResolvers<void>();
    this.identifyResolve = deferred.resolve;
    this.identifyReject = deferred.reject;
    this.identifyTimer = setTimeout(
      () => this.failIdentify(new Error("Timed out waiting for OBS WebSocket identification")),
      CONNECT_TIMEOUT_MS,
    );
    this.identifyTimer.unref();
    const onAbort = (): void => this.failIdentify(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await deferred.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  private receive(raw: RawData, isBinary: boolean): void {
    if (isBinary) return this.close(new Error("OBS sent an unexpected binary WebSocket frame"));
    let text: string;
    try {
      text = textPayload(raw);
    } catch (error) {
      this.close(error instanceof Error ? error : new Error("OBS sent an invalid WebSocket payload"));
      return;
    }
    let message: unknown;
    try { message = JSON.parse(text); } catch { this.close(new Error("OBS sent malformed JSON")); return; }
    if (!isObject(message) || typeof message.op !== "number" || !isObject(message.d)) {
      this.close(new Error("OBS sent an invalid protocol message"));
      return;
    }
    if (message.op === 0) {
      if (this.identified || this.identifyResolve === undefined) return this.close(new Error("OBS sent an unexpected Hello"));
      const rpcVersion = message.d.rpcVersion;
      if (!Number.isSafeInteger(rpcVersion) || (rpcVersion as number) < 1) return this.failIdentify(new Error("OBS WebSocket v5 RPC is not available"));
      const authentication = message.d.authentication;
      let authenticationValue: string | undefined;
      if (authentication !== undefined) {
        if (!isObject(authentication) || this.password === undefined) return this.failIdentify(new Error("OBS WebSocket requires a password"));
        try { authenticationValue = authResponse(this.password, requiredString(authentication.salt, "authentication salt"), requiredString(authentication.challenge, "authentication challenge")); }
        catch (error) { return this.failIdentify(error instanceof Error ? error : new Error("Invalid OBS authentication challenge")); }
      }
      this.send({ op: 1, d: { rpcVersion: Math.min(rpcVersion as number, 1), eventSubscriptions: 69, ...(authenticationValue === undefined ? {} : { authentication: authenticationValue }) } });
      return;
    }
    if (message.op === 2) {
      this.identified = true;
      this.finishIdentify();
      return;
    }
    if (message.op === 5) {
      const type = message.d.eventType;
      if (typeof type === "string") this.onEvent(type, isObject(message.d.eventData) ? message.d.eventData : {});
      return;
    }
    if (message.op === 7) {
      const id = message.d.requestId;
      if (typeof id !== "string") return this.close(new Error("OBS sent a response without a request id"));
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const status = message.d.requestStatus;
      if (!isObject(status) || status.result !== true) {
        const code = isObject(status) && typeof status.code === "number" ? ` (${String(status.code)})` : "";
        const comment = isObject(status) && typeof status.comment === "string" ? `: ${status.comment}` : "";
        pending.reject(new Error(`OBS request failed${code}${comment}`));
      } else pending.resolve(isObject(message.d.responseData) ? message.d.responseData : {});
    }
  }

  private finishIdentify(): void {
    clearTimeout(this.identifyTimer);
    this.identifyTimer = undefined;
    const resolve = this.identifyResolve;
    this.identifyResolve = undefined;
    this.identifyReject = undefined;
    resolve?.();
  }

  private failIdentify(error: Error): void {
    clearTimeout(this.identifyTimer);
    this.identifyTimer = undefined;
    const reject = this.identifyReject;
    this.identifyResolve = undefined;
    this.identifyReject = undefined;
    reject?.(error);
    this.close(error);
  }

  request(requestType: string, requestData: JsonObject = {}, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.connected) return Promise.reject(new Error("OBS WebSocket is not connected"));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("OBS request limit reached"));
    const requestId = `${++this.requestNumber}-${randomUUID()}`;
    return new Promise<JsonObject>((resolve, reject) => {
      const fail = (error: Error): void => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = (): void => fail(abortError());
      const timer = setTimeout(() => fail(new Error(`OBS request ${requestType} timed out`)), REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(requestId, {
        resolve: (data) => { signal?.removeEventListener("abort", onAbort); resolve(data); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try { this.send({ op: 6, d: { requestType, requestId, requestData } }); } catch (error) { fail(error instanceof Error ? error : new Error("Unable to send OBS request")); }
    });
  }

  async waitForVirtualCam(active: boolean, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    do {
      const status = await this.request("GetVirtualCamStatus", {}, signal);
      if (status.outputActive === active) return;
      await delay(50, undefined, { signal });
    } while (Date.now() < deadline);
    throw new Error(`OBS Virtual Camera did not ${active ? "start" : "stop"} within eight seconds`);
  }

  private send(message: JsonObject): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("OBS WebSocket is not open");
    this.socket.send(JSON.stringify(message));
  }

  close(reason = new Error("OBS WebSocket closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.identified = false;
    clearTimeout(this.identifyTimer);
    this.identifyReject?.(reason);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      const timer = setTimeout(() => socket.terminate(), 1_000);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
      socket.close();
    }
    this.onDisconnect(reason);
  }
}

export class ObsVirtualCamera {
  private readonly url: string;
  private readonly password: string | undefined;
  private readonly width: number;
  private readonly height: number;
  private readonly fps: number;
  private readonly sceneName = SCENE_NAME;
  private connection: ObsConnection | undefined;
  private saved: SavedState | undefined;
  private ownsOutput = false;
  private createdScene = false;
  private createdSource = false;
  private operation: Promise<ObsCameraStatus> | undefined;
  private startAbort: AbortController | undefined;
  private disposed = false;
  private current: ObsCameraStatus;

  constructor(config: ObsCameraConfig) {
    this.url = validateUrl(config.url);
    this.password = config.password;
    this.width = boundedInteger(config.width, DEFAULT_WIDTH, "OBS camera width", 4096);
    this.height = boundedInteger(config.height, DEFAULT_HEIGHT, "OBS camera height", 4096);
    this.fps = boundedInteger(config.fps, DEFAULT_FPS, "OBS camera fps", 240);
    this.current = this.makeStatus("stopped", false);
  }

  status(): ObsCameraStatus { return this.current; }

  start(rendererUrl: string, signal?: AbortSignal): Promise<ObsCameraStatus> {
    if (this.disposed) return Promise.reject(new Error("OBS Virtual Camera has been disposed"));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.operation !== undefined) {
      return this.operation.then((status) =>
        status.state === "stopped" ? this.start(rendererUrl, signal) : status);
    }
    if (this.current.state === "running") return Promise.resolve(this.status());
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.startAbort = controller;
    this.operation = this.startInner(rendererUrl, controller.signal).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (this.startAbort === controller) this.startAbort = undefined;
      this.operation = undefined;
    });
    return this.operation;
  }
  private async startInner(rendererUrl: string, signal?: AbortSignal): Promise<ObsCameraStatus> {
    if (this.connection !== undefined) await this.stopInner();
    this.setStatus("starting", false);
    let connection: ObsConnection | undefined;
    try {
      this.validateRendererUrl(rendererUrl);
      connection = new ObsConnection(this.url, this.password, (type, data) => this.handleEvent(type, data), (reason) => this.handleDisconnect(reason));
      this.connection = connection;
      await connection.connect(signal);
      const version = await connection.request("GetVersion", {}, signal);
      if (!requiredString(version.obsWebSocketVersion, "obs-websocket version").startsWith("5.")) throw new Error("OBS WebSocket v5 is required");
      const [virtual, recording, streaming, program, video] = await Promise.all([
        connection.request("GetVirtualCamStatus", {}, signal), connection.request("GetRecordStatus", {}, signal),
        connection.request("GetStreamStatus", {}, signal), connection.request("GetCurrentProgramScene", {}, signal),
        connection.request("GetVideoSettings", {}, signal),
      ]);
      if (virtual.outputActive === true || recording.outputActive === true || streaming.outputActive === true) throw new Error("OBS has an active output; refusing to take over");
      this.saved = { programScene: requiredString(program.sceneName ?? program.currentProgramSceneName, "program scene"), video };
      await this.ensureOwnedScene(connection, rendererUrl, signal);
      await connection.request("SetVideoSettings", { baseWidth: this.width, baseHeight: this.height, outputWidth: this.width, outputHeight: this.height, fpsNumerator: this.fps, fpsDenominator: 1 }, signal);
      await connection.request("SetCurrentProgramScene", { sceneName: this.sceneName }, signal);
      this.ownsOutput = true;
      await connection.request("StartVirtualCam", {}, signal);
      await connection.waitForVirtualCam(true, signal);
      this.createdScene = false;
      this.createdSource = false;
      this.setStatus("running", true);
      return this.status();
    } catch (error) {
      const message = errorMessage(error, "Failed to start OBS Virtual Camera");
      await this.rollback(connection);
      this.setStatus("error", false, message);
      throw new Error(message);
    }
  }

  stop(): Promise<ObsCameraStatus> {
    this.startAbort?.abort();
    if (this.operation !== undefined) return this.operation.then(() => this.stop(), () => this.stop());
    this.operation = this.stopInner().finally(() => { this.operation = undefined; });
    return this.operation;
  }

  private async stopInner(): Promise<ObsCameraStatus> {
    const connection = this.connection;
    if (connection === undefined || !connection.connected) {
      if (this.ownsOutput) {
        const error = new Error("OBS connection was lost; stop the virtual camera in OBS before restarting it");
        this.setStatus("error", false, error.message);
        throw error;
      }
      this.connection = undefined;
      this.saved = undefined;
      this.setStatus("stopped", false);
      return this.status();
    }
    this.setStatus("stopping", true);
    try {
      if (this.ownsOutput && (await connection.request("GetVirtualCamStatus")).outputActive === true) {
        await connection.request("StopVirtualCam");
        await connection.waitForVirtualCam(false);
      }
      if (this.saved !== undefined) await this.restoreIfSafe(connection);
      connection.close();
      this.connection = undefined;
      this.ownsOutput = false;
      this.saved = undefined;
      this.setStatus("stopped", false);
      return this.status();
    } catch (error) {
      this.setStatus("error", connection.connected, errorMessage(error, "Failed to stop OBS Virtual Camera"));
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.startAbort?.abort();
    try { await this.stop(); } finally { this.connection?.close(); this.connection = undefined; }
  }

  private async ensureOwnedScene(connection: ObsConnection, rendererUrl: string, signal?: AbortSignal): Promise<void> {
    const scenes = await connection.request("GetSceneList", {}, signal);
    const exists = (Array.isArray(scenes.scenes) ? scenes.scenes : []).some((scene) => isObject(scene) && scene.sceneName === this.sceneName);
    if (!exists) { await connection.request("CreateScene", { sceneName: this.sceneName }, signal); this.createdScene = true; }
    let sourceExists = false;
    try {
      const input = await connection.request("GetInputSettings", { inputName: SOURCE_NAME }, signal);
      if ((isObject(input.inputSettings) ? input.inputSettings : {}).ai_vtuber_owner !== OWNER_MARKER) throw new Error(`OBS source '${SOURCE_NAME}' already exists but is not owned by this application`);
      sourceExists = true;
    } catch (error) {
      if (!/\(600\)|\(601\)|not found/iu.test(errorMessage(error, ""))) throw error;
    }
    if (!sourceExists && exists) throw new Error(`OBS scene '${this.sceneName}' already exists without this application's owned browser source`);
    const settings = { url: rendererUrl, width: this.width, height: this.height, fps: this.fps, fps_custom: true, shutdown: true, restart_when_active: true, ai_vtuber_owner: OWNER_MARKER };
    let itemId: number;
    if (sourceExists) {
      await connection.request("SetInputSettings", { inputName: SOURCE_NAME, inputSettings: settings, overlay: true }, signal);
      itemId = (await connection.request("GetSceneItemId", { sceneName: this.sceneName, sourceName: SOURCE_NAME }, signal)).sceneItemId as number;
    } else {
      itemId = (await connection.request("CreateInput", { sceneName: this.sceneName, inputName: SOURCE_NAME, inputKind: "browser_source", inputSettings: settings, sceneItemEnabled: true }, signal)).sceneItemId as number;
      this.createdSource = true;
    }
    if (!Number.isSafeInteger(itemId)) throw new Error("OBS did not return the Live2D browser source scene item");
    const items = await connection.request("GetSceneItemList", { sceneName: this.sceneName }, signal);
    const list = Array.isArray(items.sceneItems) ? items.sceneItems : [];
    if (list.length !== 1 || !isObject(list[0]) || list[0].sourceName !== SOURCE_NAME) throw new Error(`OBS scene '${this.sceneName}' contains sources not owned by this application`);
    await connection.request("SetSceneItemEnabled", { sceneName: this.sceneName, sceneItemId: itemId, sceneItemEnabled: true }, signal);
    await connection.request("SetSceneItemTransform", { sceneName: this.sceneName, sceneItemId: itemId, sceneItemTransform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, boundsType: "OBS_BOUNDS_STRETCH", boundsWidth: this.width, boundsHeight: this.height } }, signal);
  }

  private async restoreIfSafe(connection: ObsConnection): Promise<void> {
    if (this.saved === undefined) return;
    const [recording, streaming, program] = await Promise.all([connection.request("GetRecordStatus"), connection.request("GetStreamStatus"), connection.request("GetCurrentProgramScene")]);
    if (recording.outputActive === true || streaming.outputActive === true) return;
    if ((program.sceneName ?? program.currentProgramSceneName) === this.sceneName) await connection.request("SetCurrentProgramScene", { sceneName: this.saved.programScene });
    const video = this.saved.video;
    await connection.request("SetVideoSettings", { baseWidth: video.baseWidth, baseHeight: video.baseHeight, outputWidth: video.outputWidth, outputHeight: video.outputHeight, fpsNumerator: video.fpsNumerator, fpsDenominator: video.fpsDenominator });
  }

  private async rollback(connection: ObsConnection | undefined): Promise<void> {
    if (connection?.connected) {
      try {
        if (this.ownsOutput) {
          await connection.request("StopVirtualCam");
          await connection.waitForVirtualCam(false);
        }
      } catch { /* Preserve the original startup failure. */ }
      try { await this.restoreIfSafe(connection); } catch {}
      try { if (this.createdSource) await connection.request("RemoveInput", { inputName: SOURCE_NAME }); } catch {}
      try { if (this.createdScene) await connection.request("RemoveScene", { sceneName: this.sceneName }); } catch {}
      connection.close();
    }
    if (this.connection === connection) this.connection = undefined;
    this.ownsOutput = false; this.createdSource = false; this.createdScene = false; this.saved = undefined;
  }

  private validateRendererUrl(value: string): void {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Live2D renderer URL must be an absolute HTTP(S) URL"); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0 || !isLoopbackHost(url.hostname)) throw new Error("Live2D renderer URL must be a loopback HTTP(S) URL without credentials or fragment");
  }

  private handleEvent(type: string, data: JsonObject): void {
    if (type === "VirtualcamStateChanged" && data.outputActive !== true && this.current.state === "running") { this.ownsOutput = false; this.setStatus("error", true, "OBS Virtual Camera stopped outside this application"); }
    if (type === "CurrentProgramSceneChanged" && data.sceneName !== this.sceneName && this.current.state === "running") { this.setStatus("error", true, "OBS program scene changed away from the Live2D camera scene"); if (this.ownsOutput) void this.stop().catch(() => undefined); }
  }

  private handleDisconnect(reason: Error): void { if (this.current.state !== "stopped") this.setStatus("error", false, errorMessage(reason, "OBS WebSocket disconnected")); }
  private makeStatus(state: ObsCameraStatus["state"], connected: boolean, error?: string): ObsCameraStatus { return { state, connected, deviceName: "OBS Virtual Camera", width: this.width, height: this.height, fps: this.fps, sceneName: this.sceneName, ...(error === undefined ? {} : { error }) }; }
  private setStatus(state: ObsCameraStatus["state"], connected: boolean, error?: string): void { this.current = this.makeStatus(state, connected, error); }
}
