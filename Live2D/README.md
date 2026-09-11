# Live2D 页面

本目录由 TypeScript 主程序直接提供静态页面和消息 SSE，不需要另开静态文件服务器。

## Cubism SDK 与构建

内置版本为 **Cubism 5 SDK for Web R5（5-r.5）**，Core 为官方配套的 **06.00.0001**。SDK 的发行名与 Core 的内部版本号不同；该组合支持 Cubism 5.3 导出的模型，并兼容早期 Cubism 3/4 的 `.moc3` 模型。Cubism 5.3 的新增混合模式和离屏绘制需要 **WebGL 2**；浏览器或 OBS 浏览器源应启用硬件加速。尚未发布到此稳定版 SDK 的 Editor 新特性不在兼容保证内。

模型入口仍是 `.model3.json`，不是 `.model5.json`。将导出的模型、纹理、动作、表情和物理文件按原相对路径完整放入 `live2d-model/<name>/`，入口文件名须为 `<name>.model3.json`；只替换 `.moc3` 而遗漏配套文件可能无法加载。

`src/renderer.ts` 是本项目的渲染集成源码，`js/bundle.js` 是不纳入版本控制的构建产物；首次启动前必须构建，不再手工修改旧的预打包框架。根项目的 `npm run build`、`npm run dev` 会同时构建此渲染器；仅重建 Live2D 可执行：

```bash
npm run build:live2d
```

`npm run typecheck` 同时检查 Live2D 集成。官方 Framework 源码、着色器、Core 类型声明、许可证及固定版本来源记录保存在 `vendor/`；运行和构建不需要从 CDN 下载 SDK。Core 及 Framework 必须配套升级，不能只替换 Core。重新构建后刷新 WebUI 预览或 OBS 浏览器源即可载入新资源。

上游版本：[Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/)、[Framework 5-r.5](https://github.com/Live2D/CubismWebFramework/tree/5-r.5)。Core、Framework 与模型分别适用各自许可，SDK 升级不改变模型的商用或再分发限制。

本机自行下载的 `live2d-model/sizuku/` 素材包不纳入 Git 或 Docker 构建上下文，文件仍保留在本地。使用自备模型部署前，应确认模型入口命名、运行资源完整性及其使用和分发许可。

## 启动与配置

在 `config.local.json` 中启用并设置端口：

```json
{
  "live2d": {
    "enable": true,
    "host": "127.0.0.1",
    "port": 12345,
    "name": "Hiyori",
    "camera": {
      "obs_websocket_url": "ws://127.0.0.1:4455",
      "password": "填写 OBS WebSocket 密码",
      "width": 1280,
      "height": 720,
      "fps": 30,
      "auto_start": false
    }
  }
}
```

从项目根目录启动：

```bash
npm start -- --config config.local.json
```

启动后在 WebUI 首页使用“角色预览与对话”；也可打开独立地址 `http://127.0.0.1:12345/Live2D/`。`live2d.name` 自动控制模型，资源必须位于 `Live2D/live2d-model/<name>/<name>.model3.json`；不再需要手改 `js/model_name.js`。SSE 由外部页面脚本接收，回复会成为预览字幕，画布随窗口尺寸适配。

WebUI 通过受认证的 `/avatar/Live2D/` 嵌入模型。独立端口默认回环绑定且没有操作台认证，供同机 OBS 浏览器源使用；`?camera=1` 隐藏字幕，只输出角色。容器对外提供独立页面须显式配置 `"host": "0.0.0.0"`，并自行限制访问，不能把它当作认证入口。

实时摄像头由主程序经本机 OBS WebSocket v5 控制，依赖已安装并启动的 OBS Studio 与 OBS Virtual Camera。首页可启停，直播软件选择 `OBS Virtual Camera`；默认 1280×720、30 fps。虚拟摄像头不携带透明通道和音频，透明区域为黑色，TTS 声音需独立接入虚拟麦克风。具体安装、认证、输出模式与安全限制见根目录 `README.md` 的 Live2D 章节。
