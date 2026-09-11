import { CubismModelSettingJson } from "../vendor/Framework/src/cubismmodelsettingjson";
import { CubismBreath, BreathParameterData } from "../vendor/Framework/src/effect/cubismbreath";
import { CubismEyeBlink } from "../vendor/Framework/src/effect/cubismeyeblink";
import { CubismFramework, LogLevel, Option } from "../vendor/Framework/src/live2dcubismframework";
import { CubismMatrix44 } from "../vendor/Framework/src/math/cubismmatrix44";
import { CubismUserModel } from "../vendor/Framework/src/model/cubismusermodel";
import { ACubismMotion } from "../vendor/Framework/src/motion/acubismmotion";
import { CubismMotion } from "../vendor/Framework/src/motion/cubismmotion";
import { CubismWebGLOffscreenManager } from "../vendor/Framework/src/rendering/cubismoffscreenmanager";
import { CubismShaderManager_WebGL } from "../vendor/Framework/src/rendering/cubismshader_webgl";

declare global {
  interface Window {
    model_name: string;
    live2dResize?: () => void;
  }
  interface Document {
    live2d_release?: () => void;
    touchHeadHandler?: () => void;
    touchBodyHandler?: () => void;
  }
}

const SHADER_PATH = new URL("vendor/Framework/Shaders/WebGL/", document.baseURI).href;

async function loadBytes(url: URL, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Live2D asset ${url.pathname}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  return bytes;
}

function loadImage(url: URL, signal: AbortSignal): Promise<HTMLImageElement> {
  const { promise, resolve, reject } = Promise.withResolvers<HTMLImageElement>();
  const image = new Image();
  const cleanup = (): void => {
    image.onload = null;
    image.onerror = null;
    signal.removeEventListener("abort", abort);
  };
  const abort = (): void => {
    cleanup();
    image.src = "";
    reject(signal.reason);
  };
  image.onload = () => { cleanup(); resolve(image); };
  image.onerror = () => { cleanup(); reject(new Error(`Live2D texture failed: ${url.pathname}`)); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  else image.src = url.href;
  return promise;
}

class AvatarModel extends CubismUserModel {
  private setting: CubismModelSettingJson;
  private readonly motions = new Map<string, CubismMotion[]>();
  private readonly expressions: ACubismMotion[] = [];
  private readonly textures: WebGLTexture[] = [];
  private readonly ids = ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamEyeBallX", "ParamEyeBallY"]
    .map((name) => CubismFramework.getIdManager().getId(name));

  async load(name: string, canvas: HTMLCanvasElement, gl: WebGLRenderingContext, signal: AbortSignal): Promise<void> {
    const directory = new URL(`live2d-model/${encodeURIComponent(name)}/`, document.baseURI);
    const definition = await loadBytes(new URL(`${encodeURIComponent(name)}.model3.json`, directory), signal);
    this.setting = new CubismModelSettingJson(definition, definition.byteLength);
    const moc = this.setting.getModelFileName();
    if (!moc) throw new Error("Live2D model definition has no MOC3 file");
    this.loadModel(await loadBytes(new URL(moc, directory), signal), true);
    if (!this.getModel()) throw new Error("Live2D MOC3 is invalid or newer than the bundled Cubism SDK");
    if (this.getModel().isBlendModeEnabled() &&
        (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext))) {
      throw new Error("Cubism 5.3 blend modes and offscreen rendering require WebGL 2");
    }

    const layout = new Map<string, number>();
    this.setting.getLayoutMap(layout);
    this.getModelMatrix().setupFromLayout(layout);
    const eyeIds = Array.from({ length: this.setting.getEyeBlinkParameterCount() }, (_, i) => this.setting.getEyeBlinkParameterId(i));
    const lipIds = Array.from({ length: this.setting.getLipSyncParameterCount() }, (_, i) => this.setting.getLipSyncParameterId(i));
    if (eyeIds.length) this._eyeBlink = CubismEyeBlink.create(this.setting);
    this._breath = CubismBreath.create();
    this._breath.setParameters([
      new BreathParameterData(this.ids[0], 0, 15, 6.5345, 0.5),
      new BreathParameterData(this.ids[1], 0, 8, 3.5345, 0.5),
      new BreathParameterData(this.ids[2], 0, 10, 5.5345, 0.5),
      new BreathParameterData(this.ids[3], 0, 4, 15.5345, 0.5),
      new BreathParameterData(CubismFramework.getIdManager().getId("ParamBreath"), 0.5, 0.5, 3.2345, 1),
    ]);

    // Finish each acquisition before ownership can be released on cancellation.
    for (const [file, load] of [
      [this.setting.getPhysicsFileName(), (bytes: ArrayBuffer) => this.loadPhysics(bytes, bytes.byteLength)],
      [this.setting.getPoseFileName(), (bytes: ArrayBuffer) => this.loadPose(bytes, bytes.byteLength)],
      [this.setting.getUserDataFile(), (bytes: ArrayBuffer) => this.loadUserData(bytes, bytes.byteLength)],
    ] as const) {
      if (file) load(await loadBytes(new URL(file, directory), signal));
    }
    for (let i = 0; i < this.setting.getExpressionCount(); i++) {
      const bytes = await loadBytes(new URL(this.setting.getExpressionFileName(i), directory), signal);
      const expression = this.loadExpression(bytes, bytes.byteLength, this.setting.getExpressionName(i));
      if (!expression) throw new Error("Live2D expression could not be decoded");
      this.expressions.push(expression);
    }
    for (let groupIndex = 0; groupIndex < this.setting.getMotionGroupCount(); groupIndex++) {
      const group = this.setting.getMotionGroupName(groupIndex);
      const motions: CubismMotion[] = [];
      this.motions.set(group, motions);
      for (let i = 0; i < this.setting.getMotionCount(group); i++) {
        const bytes = await loadBytes(new URL(this.setting.getMotionFileName(group, i), directory), signal);
        const motion = this.loadMotion(bytes, bytes.byteLength, `${group}_${i}`, undefined, undefined, this.setting, group, i);
        if (!motion) throw new Error(`Live2D motion could not be decoded: ${group}_${i}`);
        motion.setEffectIds(eyeIds, lipIds);
        motions.push(motion);
      }
    }

    this.createRenderer(canvas.width, canvas.height);
    const renderer = this.getRenderer();
    renderer.startUp(gl);
    renderer.setIsPremultipliedAlpha(true);
    for (let i = 0; i < this.setting.getTextureCount(); i++) {
      const file = this.setting.getTextureFileName(i);
      if (!file) continue;
      const image = await loadImage(new URL(file, directory), signal);
      signal.throwIfAborted();
      const texture = gl.createTexture();
      if (!texture) throw new Error("Live2D could not allocate a texture");
      this.textures.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      renderer.bindTexture(i, texture);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    renderer.loadShaders(SHADER_PATH);
    // R5 exposes a fire-and-forget loader. Do not announce readiness or release
    // its GL resources while its asynchronous shader compilation is still running.
    const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
    while (shader._isShaderLoading) {
      const { promise, resolve } = Promise.withResolvers<void>();
      window.setTimeout(resolve, 16);
      await promise;
    }
    signal.throwIfAborted();
    if (!shader._isShaderLoaded) throw new Error("Live2D shaders failed to load or compile");
    this.setInitialized(true);
  }

  update(delta: number): void {
    this._model.loadParameters();
    if (this._motionManager.isFinished()) this.startRandomMotion("Idle", 1);
    const motionUpdated = this._motionManager.updateMotion(this._model, delta);
    this._model.saveParameters();
    if (!motionUpdated) this._eyeBlink?.updateParameters(this._model, delta);
    this._expressionManager.updateMotion(this._model, delta);
    this._dragManager.update(delta);
    const x = this._dragManager.getX();
    const y = this._dragManager.getY();
    this._model.addParameterValueById(this.ids[0], x * 30);
    this._model.addParameterValueById(this.ids[1], y * 30);
    this._model.addParameterValueById(this.ids[2], x * y * -30);
    this._model.addParameterValueById(this.ids[3], x * 10);
    this._model.addParameterValueById(this.ids[4], x);
    this._model.addParameterValueById(this.ids[5], y);
    this._breath.updateParameters(this._model, delta);
    this._physics?.evaluate(this._model, delta);
    this._pose?.updateParameters(this._model, delta);
    this._model.update();
  }

  tap(x: number, y: number): void {
    for (let i = 0; i < this.setting.getHitAreasCount(); i++) {
      if (!this.isHit(this.setting.getHitAreaId(i), x, y)) continue;
      const area = this.setting.getHitAreaName(i);
      if (area === "Head") {
        document.touchHeadHandler?.();
        const expression = this.expressions[Math.floor(Math.random() * this.expressions.length)];
        if (expression) this._expressionManager.startMotion(expression, false);
        this.startRandomMotion("TapHead", 2);
      } else if (area === "Body") {
        document.touchBodyHandler?.();
        this.startRandomMotion("TapBody", 2);
      }
      break;
    }
  }

  private startRandomMotion(group: string, priority: number): void {
    const motions = this.motions.get(group);
    if (!motions?.length || !this._motionManager.reserveMotion(priority)) return;
    this._motionManager.startMotionPriority(motions[Math.floor(Math.random() * motions.length)], false, priority);
  }

  dispose(gl: WebGLRenderingContext): void {
    // Renderer/offscreen resources still refer to the model; release them first.
    this.deleteRenderer();
    super.release();
    for (const motions of this.motions.values()) for (const motion of motions) ACubismMotion.delete(motion);
    for (const expression of this.expressions) ACubismMotion.delete(expression);
    for (const texture of this.textures) gl.deleteTexture(texture);
    this.motions.clear();
    this.expressions.length = 0;
    this.textures.length = 0;
    this.setting?.release();
  }
}

async function start(): Promise<void> {
  const canvas = document.getElementById("live2d") as HTMLCanvasElement | null;
  if (!canvas) return;
  const report = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    window.dispatchEvent(new CustomEvent("live2d-error", { detail: message }));
  };
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl) { report(new Error("WebGL is unavailable")); return; }
  const options = new Option();
  options.logFunction = (message) => console.info(message);
  options.loggingLevel = LogLevel.LogLevel_Warning;
  if (!CubismFramework.startUp(options)) { report(new Error("Cubism Core initialization failed")); return; }
  CubismFramework.initialize();

  const model = new AvatarModel();
  const controller = new AbortController();
  const { signal } = controller;
  const projection = new CubismMatrix44();
  const mvp = new CubismMatrix44();
  const viewport = [0, 0, canvas.width, canvas.height];
  const offscreen = CubismWebGLOffscreenManager.getInstance();
  let frame = 0;
  let loading = true;
  let released = false;
  let previousTime = 0;
  let captured: number | undefined;

  const release = (): void => {
    if (released) return;
    released = true;
    model.dispose(gl);
    CubismFramework.dispose();
    CubismFramework.cleanUp();
    if (window.live2dResize === resize) delete window.live2dResize;
  };
  const dispose = (): void => {
    controller.abort();
    window.cancelAnimationFrame(frame);
    if (!loading) release();
  };
  const resize = (): void => {
    if (signal.aborted || !model.isInitialized()) return;
    viewport[2] = canvas.width;
    viewport[3] = canvas.height;
    const aspect = canvas.width / canvas.height;
    const matrix = model.getModelMatrix();
    const width = model.getModel().getCanvasWidth() * matrix.getScaleX();
    const height = model.getModel().getCanvasHeight() * matrix.getScaleY();
    const fit = Math.min(2 * aspect / width, 2 / height);
    projection.loadIdentity();
    projection.scale(fit / aspect, fit);
    mvp.setMatrix(projection.getArray());
    mvp.multiplyByMatrix(matrix);
    model.setRenderTargetSize(canvas.width, canvas.height);
  };
  const draw = (time: number): void => {
    if (signal.aborted) return;
    try {
      const delta = previousTime === 0 ? 0 : Math.min((time - previousTime) / 1_000, 0.1);
      previousTime = time;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      offscreen.beginFrameProcess(gl);
      model.update(delta);
      const renderer = model.getRenderer();
      renderer.setMvpMatrix(mvp);
      renderer.setRenderState(null, viewport);
      renderer.drawModel(SHADER_PATH);
      offscreen.endFrameProcess(gl);
      offscreen.releaseStaleRenderTextures(gl);
      frame = window.requestAnimationFrame(draw);
    } catch (error) {
      report(error);
      dispose();
    }
  };
  const point = (event: PointerEvent): [number, number] => {
    const bounds = canvas.getBoundingClientRect();
    return [
      projection.invertTransformX((event.clientX - bounds.left) / bounds.width * 2 - 1),
      projection.invertTransformY(1 - (event.clientY - bounds.top) / bounds.height * 2),
    ];
  };
  window.live2dResize = resize;
  document.live2d_release = dispose;
  canvas.addEventListener("pointerdown", (event) => {
    if (!model.isInitialized()) return;
    captured = event.pointerId;
    canvas.setPointerCapture(captured);
    model.setDragging(...point(event));
  }, { signal });
  canvas.addEventListener("pointermove", (event) => {
    if (captured === event.pointerId) model.setDragging(...point(event));
  }, { signal });
  canvas.addEventListener("pointerup", (event) => {
    if (captured !== event.pointerId) return;
    captured = undefined;
    canvas.releasePointerCapture(event.pointerId);
    model.tap(...point(event));
    model.setDragging(0, 0);
  }, { signal });
  canvas.addEventListener("lostpointercapture", () => { captured = undefined; model.setDragging(0, 0); }, { signal });
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    report(new Error("Live2D WebGL context was lost; reload the preview"));
    dispose();
  }, { signal });
  window.addEventListener("beforeunload", dispose, { once: true, signal });

  try {
    await model.load(window.model_name, canvas, gl, signal);
    loading = false;
    resize();
    draw(performance.now());
    if (!signal.aborted) window.dispatchEvent(new Event("live2d-ready"));
  } catch (error) {
    if (!signal.aborted) report(error);
    dispose();
  } finally {
    loading = false;
    if (signal.aborted) release();
  }
}

window.addEventListener("load", () => {
  void start().catch((error: unknown) => {
    window.dispatchEvent(new CustomEvent("live2d-error", { detail: error instanceof Error ? error.message : String(error) }));
  });
}, { once: true });
