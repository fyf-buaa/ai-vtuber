import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ObsVirtualCamera } from "../src/output/obs-camera.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function obsPeer(recording = false) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No OBS test endpoint");
  const state = {
    active: false,
    pending: undefined as boolean | undefined,
    statusReads: 0,
    scene: "Original",
    source: undefined as Record<string, unknown> | undefined,
    scenes: ["Original"],
    video: { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 },
  };
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        op: number;
        d: { requestType: string; requestId: string; requestData: Record<string, unknown> };
      };
      if (message.op === 1) {
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      const { requestType, requestId, requestData } = message.d;
      let responseData: unknown = {};
      let code = 100;
      switch (requestType) {
        case "GetVersion": responseData = { obsWebSocketVersion: "5.7.4" }; break;
        case "GetVirtualCamStatus":
          responseData = { outputActive: state.active };
          // OBS acknowledges commands before the video thread completes them.
          if (state.pending !== undefined && ++state.statusReads === 2) {
            state.active = state.pending;
            state.pending = undefined;
          }
          break;
        case "GetRecordStatus": responseData = { outputActive: recording }; break;
        case "GetStreamStatus": responseData = { outputActive: false }; break;
        case "GetCurrentProgramScene": responseData = { sceneName: state.scene }; break;
        case "GetVideoSettings": responseData = state.video; break;
        case "GetSceneList": responseData = { scenes: state.scenes.map((sceneName) => ({ sceneName })) }; break;
        case "CreateScene": state.scenes.push(String(requestData.sceneName)); break;
        case "GetInputSettings":
          if (state.source === undefined) code = 600;
          else responseData = { inputSettings: state.source, inputKind: "browser_source" };
          break;
        case "CreateInput":
        case "SetInputSettings":
          state.source = requestData.inputSettings as Record<string, unknown>;
          responseData = { sceneItemId: 1 };
          break;
        case "GetSceneItemId": responseData = { sceneItemId: 1 }; break;
        case "GetSceneItemList": responseData = { sceneItems: [{ sceneItemId: 1, sourceName: "AI Vtuber Live2D Browser" }] }; break;
        case "SetSceneItemTransform":
        case "SetSceneItemEnabled": break;
        case "SetVideoSettings": state.video = { ...state.video, ...requestData }; break;
        case "SetCurrentProgramScene": state.scene = String(requestData.sceneName); break;
        case "StartVirtualCam": state.pending = true; state.statusReads = 0; break;
        case "StopVirtualCam": state.pending = false; state.statusReads = 0; break;
        case "RemoveInput": state.source = undefined; break;
        case "RemoveScene": state.scenes = state.scenes.filter((name) => name !== requestData.sceneName); break;
        default: code = 204;
      }
      socket.send(JSON.stringify({
        op: 7,
        d: { requestType, requestId, requestStatus: { result: code === 100, code }, responseData },
      }));
    });
    // Exercise Hello arriving immediately after the WebSocket upgrade.
    socket.send(JSON.stringify({ op: 0, d: { rpcVersion: 1 } }));
  });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const camera = new ObsVirtualCamera({ url: `ws://127.0.0.1:${address.port}` });
  cleanups.push(async () => camera.dispose());
  return { state, camera };
}

describe("OBS virtual camera lifecycle", () => {
  it("waits for actual asynchronous output transitions and restores the prior scene and video", async () => {
    const { state, camera } = await obsPeer();
    const originalVideo = { ...state.video };
    await expect(camera.start("http://127.0.0.1:12345/Live2D/?camera=1")).resolves.toMatchObject({ state: "running" });
    expect(state.active).toBe(true);
    expect(state.scene).toBe("AI Vtuber Live2D");
    await expect(camera.stop()).resolves.toMatchObject({ state: "stopped" });
    expect(state.active).toBe(false);
    expect(state.scene).toBe("Original");
    expect(state.video).toEqual(originalVideo);
  });

  it("leaves an existing recording and its scene untouched", async () => {
    const { state, camera } = await obsPeer(true);
    const before = structuredClone(state);
    await expect(camera.start("http://127.0.0.1:12345/Live2D/?camera=1")).rejects.toThrow("active output");
    expect(state).toEqual(before);
  });

  it("does not open a connection for an already cancelled or disposed start", async () => {
    const camera = new ObsVirtualCamera({ url: "ws://127.0.0.1:1" });
    const controller = new AbortController();
    controller.abort();
    await expect(camera.start("http://127.0.0.1:12345/Live2D/", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await camera.dispose();
    await expect(camera.start("http://127.0.0.1:12345/Live2D/")).rejects.toThrow("disposed");
  });
});
