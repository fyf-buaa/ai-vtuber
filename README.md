# AI-Vtuber（Node 22 / TypeScript）

本项目基于 [Ikaros-521/AI-Vtuber](https://github.com/Ikaros-521/AI-Vtuber) 二次开发，感谢原项目作者及贡献者的开源工作。

## 1. 前置条件与目录布局

- Node.js **22.19.0 或更高版本**（包含 npm）。
- Git 仅在需要拉取更新时使用。
- `pi/` 已作为固定版本的源码随本仓库提供；无需、也不要再准备同级 `../pi`。
- 启用虚拟麦克风需要操作系统虚拟音频线、可执行的 mpv 和 FFmpeg；远程 TTS 及直播中转服务需要自行启动。

```text
AI-Vtuber-20250604/
├─ pi/                 # 固定来源的 Pi 源码（不是嵌套 Git 仓库）
├─ package.json
├─ config.example.json # 可提交的安全模板
├─ config.local.json   # 本机配置和密钥，不提交
├─ src/
├─ web/
└─ Scripts/
```

检查版本：

```bash
node --version
npm --version
```

## 2. 安装、构建与启动

首次安装（两个 `ci` 均禁用安装生命周期脚本）：

```bash
npm run install:pi
npm ci --ignore-scripts
```

未传入 `--config` 的首次启动会从 `config.example.json` 和 `config.example.json.bak` 生成同目录的 `config.local.json` 和 `config.local.json.bak`，不会覆盖已有文件。也可先手动复制两份模板并编辑本机配置，密钥只放在本机文件或环境变量中；显式指定的配置路径必须已存在。

Windows 也可双击 `Scripts/2-2.安装依赖.bat`。它只安装内置 `pi` 和本项目的 npm 依赖。

```bash
# 构建 pi、服务端 TypeScript 和浏览器端资源
npm run build

# 开发模式（构建内置 pi/web 后监听 src）
npm run dev

# 生产启动；prestart 会先完成构建
npm start
```

Windows 双击入口为根目录 `1.双击我启动程序.bat`；它和 `Scripts/1.双击我启动程序.bat` 都只转交给权威启动器 `Scripts/start.bat`。PowerShell 可运行：

```powershell
& .\Scripts\start.ps1
```

`start.bat`/`start.ps1` 会在运行时请求受监督重启时重新拉起进程。

Windows 启动器只在首次拉起时自动传入 `--open-webui`：双击启动会等待操作台 HTTP 服务就绪，再用系统默认浏览器打开页面；退出码 75 触发的受监督重启不会重复打开。若同时传入 `--no-server`，则不会尝试打开浏览器。

## 3. CLI

```text
npm start -- [选项]
  --config <path>   使用指定的兼容 JSON 配置（默认 config.local.json）
  --stdin           从标准输入接收文本和 /命令
  --no-stdin        禁用标准输入控制
  --manual <text>   提交一次手动 talk 事件
  --reread <text>   提交一次无需模型凭据的复读事件
  --no-server       不启动操作台 HTTP 服务
  --open-webui      操作台 HTTP 服务就绪后用系统默认浏览器打开页面
  --no-platform     不连接直播平台来源
  --help            显示帮助
```

直接运行 `npm start` 不会自动打开浏览器；如需相同行为，请显式传入 `npm start -- --open-webui`。

启用 `--stdin` 后可使用 `/status`、`/start`、`/reload`、`/restore`、`/restart`、`/stop`。一次性排障示例：

```bash
npm start -- --config config.local.json --no-platform --manual "你好"
npm start -- --config config.local.json --no-platform --reread "音频链路检查"
```

## 4. 操作台、API 与认证

监听地址按 `webui.ip` → `api_ip` → `127.0.0.1` 解析，端口按 `webui.port` → `api_port` → `8081` 解析。启动后访问 `http://127.0.0.1:8081/`（以实际配置为准）。

结构化配置页位于同源地址 `/settings`（`/settings/` 同样可用），将“Pi Agent”作为首要分类：根 `agent` 配置主对话模型，运行模式、provider、model 与思考等级直接使用服务端投影的 Pi 模型目录，模型切换会同步上下文窗口、输出上限，以及“推理、视觉、工具”三个能力勾选框。“专用视觉模型”作为同一分类的折叠子版块展示；仅当主模型不支持 `image` 输入且该开关启用时，图片才交给这里独立配置的 provider、model、端点和凭据转述。主模型本身支持图片时会直接处理，专用视觉模型保持待机；专用模型选择器只列出声明支持 `image` 输入的模型。旧的根 LLM 字段（包括 `chat_type`、`provider`、`system_prompt` 和旧提供方段）以及 `agent` 内的旧 snake_case 别名会被明确拒绝，而不会回退或迁移。其余配置仍按原 NiceGUI WebUI 的分类顺序展示中文名称；未覆盖的扩展字段进入“其他配置”，不会被丢弃。页面不会把原始 JSON 路径显示为界面文字；左侧目录按分类独立折叠，配置正文支持展开/折叠、类型保持的控件与统一撤销未保存更改，普通数组及空对象使用 JSON 文本框。服务端返回的 `[REDACTED]` 密钥占位符会在保存时保留原值。首页 `/` 的原始 JSON 配置编辑器继续保留，供需要直接处理完整文档的高级场景使用。

建议用环境变量设置操作台令牌，不要把真实令牌写入镜像或提交到仓库：

```powershell
$env:AI_VTUBER_OPERATOR_TOKEN = "替换为高强度随机值"
npm start -- --config config.local.json
```

也兼容 `AI_VTUBER_AUTH_TOKEN`，以及 `server.operator.token`、`server.auth.token`、`operator.auth.token`、`webui.auth.token`、`webui.auth_token`、`webui.api_token`。配置令牌后，API、旧版兼容路由和配置的静态映射要求 `Authorization: Bearer <token>`；首页与 `/settings` 在同一浏览器标签页内共用 `sessionStorage` 的 `ai-vtuber.operator-token`，令牌不会写入长期存储，不同标签页需要分别连接。未配置令牌时，服务只允许绑定回环地址，并且敏感路由同时校验连接来源与 `Host` 为 `localhost`/回环 IP；非回环绑定会拒绝启动，而不是无认证暴露。`/healthz` 与 `/readyz` 用于存活/就绪探测。

主要接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/HEAD | `/healthz`、`/readyz` | 存活与就绪状态 |
| GET/HEAD | `/settings`、`/settings/` | 结构化配置编辑页 |
| GET/PUT | `/api/config` | 读取脱敏配置、校验并原子保存配置 |
| GET | `/api/agent/catalog` | 读取 Pi provider/model 能力目录及当前配置建议 |
| POST | `/api/events/manual` | 提交手动事件 |
| GET | `/api/events` | SSE 状态/事件流 |
| GET | `/api/status` | 运行时与语音队列状态 |
| GET/HEAD | `/api/avatar` | Live2D 模型、同源预览地址与虚拟摄像头状态 |
| POST | `/api/avatar/camera` | `{"action":"start"}` / `{"action":"stop"}` 控制 OBS 虚拟摄像头 |
| POST | `/api/actions` | `{"action":"reload"}` 或 `{"action":"stop"}` |
| GET | `/api/analytics/comment-word-frequency` | 弹幕词频 |
| GET | `/api/analytics/integral-ranking` | 积分排行 |
| GET | `/api/analytics/gift-aggregates` | 礼物聚合 |

`/send`、`/llm`、`/tts`、`/callback`、`/get_sys_info`、`/sys_cmd` 作为兼容别名保留。`/sys_cmd` 支持 `run`、`stop`、`restart`、`factory`；`factory` 只允许从当前配置旁的 `.bak` 文件恢复，不能指定任意文件路径。

```bash
curl -H "Authorization: Bearer $AI_VTUBER_OPERATOR_TOKEN" http://127.0.0.1:8081/api/status
curl -X POST -H "Authorization: Bearer $AI_VTUBER_OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{"content":"你好"}' http://127.0.0.1:8081/api/events/manual
```

## 5. 内置 Pi 与模型提供方

`pi/` 是随本仓库发布的固定版本源码依赖，不是另一个需要监听端口的守护进程，也不是嵌套 Git 仓库。来源、上游 remote 和固定 commit 记录在 `pi/.source.json`；其上游许可证 `pi/LICENSE` 一并保留。`npm run build` 会构建 `pi-telemetry`、`pi-ai` 和 `pi-agent-core`，再构建本项目。不要把依赖改回远程包或同级目录。

离线构建所需的模型数据快照也已内置，校验和记录在同一来源文件中；不需要在构建时访问模型目录服务。本项目根许可证与 Pi 的 MIT 许可证分别适用，Live2D 引擎和模型还受 `Live2D/` 内各自条款约束，不能因源码打包便视为已取得所有素材的商用或再分发许可。

根 `agent` 是唯一的大语言模型配置；`chat_type`、`provider`、`system_prompt`、旧提供方段及 `agent` 内的旧 snake_case 别名不再支持：

```json
{
  "agent": {
    "mode": "llm",
    "provider": "openai-compatible",
    "model": "local-model",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "thinkingLevel": "medium",
    "reasoning": false,
    "input": ["text"],
    "tools": true,
    "systemPrompt": "你是直播间助手",
    "contextWindow": 32768,
    "maxTokens": 4096
  }
}
```

可用 provider ID 包括 `openai`、`google`、`anthropic`、`qwen`、`moonshotai`、`moonshotai-cn`、`deepseek`、`openrouter`、`openai-compatible`。`mode` 可设为 `llm`、`reread` 或 `disabled`；缺省配置保持禁用，不会因打开设置页而启用模型回复。可在 `agent.apiKey` 或提供方标准环境变量中提供密钥；环境密钥只用于该提供方的官方默认端点。自定义 OpenAI 兼容端点必须设置 `baseUrl`，远程端点还必须显式配置 `apiKey` 或授权请求头；仅回环地址默认允许无密钥。通过 WebUI 改变已有凭据所属的 provider 或端点时必须重新输入凭据，不能把 `[REDACTED]` 占位符绑定到新端点。未知提供方、未知模型、缺少端点或占位密钥都会明确失败。

WebUI 将模型能力统一显示为“推理、视觉、工具”三个勾选框。选择内置模型时会根据 Pi 模型目录自动同步默认勾选状态；随后可以关闭已有能力，但不能为内置模型开启目录未声明的能力。自定义 OpenAI 兼容模型没有内置能力元数据，需通过这些字段显式声明。取消 `agent.tools` 后，运行时不会向模型注入静态工具或会话工具。

WebUI 与规范 `agent` 的 provider/model 目录只暴露可通过 API key 或提供方标准环境凭据使用的 provider；OAuth-only provider（当前为 `openai-codex`，即 OpenAI Codex）不会作为接入项，直接提交启用配置也会被拒绝；同时提供 API key 与 OAuth 的 mixed-auth provider（如 `anthropic`、`github-copilot`）仍会保留。

图片事件统一通过 Pi Agent 框架处理：主 `agent` 的有效模型支持 `image` 时直接处理；否则，`image_recognition.enable` 必须启用并配置独立的视觉 provider、model、API 凭据、系统提示词和转述指令。服务端保存和运行时都会要求专用模型支持 `image` 输入，自定义 OpenAI 兼容模型会被固定声明为视觉输入且不会注入主 Agent 工具。旧的截图/摄像头采集、定时循环、图片落盘字段，以及旧 `gemini`、`zhipu`、`blip` 子配置均已移除。

对话会话优先按“平台 + 稳定用户 ID”保持历史；平台没有提供有效用户 ID 时才使用昵称，两个身份空间互不混用。改昵称不会丢失同一用户的上下文，上游显式提供的 `metadata.sessionId` 仍优先。

长会话按有效模型的 `contextWindow` 控制输入容量：为输出预留 `maxTokens`（最多占窗口的一半），并为剩余输入留出 10% 估算余量。运行时复用 Pi 的 Token 估算并用提供方实际用量校准，按完整旧轮次裁剪历史，保留当前请求及其工具调用/结果，不额外调用模型生成摘要。如果当前轮、系统提示或工具定义本身仍超出预算，会明确拒绝本次请求，保留此前有效历史；Token 估算不能替代提供方自己的精确限制。

## 6. 配置、重载与恢复

- 本机配置使用 `config.local.json`、`config.local.json.bak`；安全模板为 `config.example.json`、`config.example.json.bak`。首次启动仅从安全模板创建缺失的本机配置；已有的旧 `config.json` 与 `config.json.bak` 不会自动迁移，须由操作员按需检查并手动迁移。未知扩展段保持不变，但过时的 LLM 根字段与 `agent` 内的旧 snake_case 别名必须删除；图片转述的回退模型配置在 `image_recognition`。
- Stable Diffusion 和 Web 字幕打印机已移除：不再提供绘图命令、绘图提示词优化、`generate_image` 工具、绘图静态图片虚拟相机或远程字幕打印请求。当前配置及恢复模板已删除根 `sd`、`web_captions_printer` 和 `webui.show_card.common_config` 下的同名开关；从历史备份恢复时也应删除这些字段。图片转述、本地文件字幕、Live2D／OBS 实时摄像头保留，历史 `backup/`、`data/`、`out/` 素材不作修改。
- 按键／文案／音频／图片映射和洛曦直播弹幕助手已移除，当前配置及恢复模板不再包含 `key_mapping`、`luoxi_project`。从历史备份迁移时，请同时删除这两段及 `filter.priority_mapping.key_mapping`、`webui.show_card.common_config.key_mapping`。小红书本地 WebSocket 转发不属于当前开放平台，不能用历史脚本或配置重新启用。
- 自定义命令、动态配置和异常报警已移除，当前配置及恢复模板不再包含 `custom_cmd`、`trends_config`、`abnormal_alarm`。从历史备份迁移时，请删除这三段、对应的 `webui.show_card.common_config` 字段及 `filter.priority_mapping.abnormal_alarm`。不再按弹幕或回复匹配 HTTP 命令，也不再通过错误计数播放报警音频或请求自动重启；普通错误事件与日志、手动重启、配置保存和热重载保留。
- 动态文案和本地问答已移除：不再扫描动态文案目录、改写或循环播报其中的文本，也不再根据问答库或音频文件名匹配回复；本地问答的周期缓存与批量触发一并删除。当前配置及恢复模板不再包含 `trends_copywriting`、`local_qa`，对应页面入口、显示开关和语音优先级也已移除。从历史备份迁移时，请删除这两段、`webui.show_card.common_config` 下的同名字段，以及 `speech.priority_mapping`（或旧 `filter.priority_mapping`）下的 `trends_copywriting`、`local_qa_audio`。`schedule` 定时任务、闲时 LLM 通知和答谢保留；历史 `data/`、`out/` 素材及 `backup/` 不会自动删除。
- “文案与音频合成”和“点歌模式”已移除：不再提供独立文案合成页面、文案音频循环播放、歌曲目录扫描与匹配、随机点歌及取消点歌命令。当前配置及恢复模板已删除根 `copywriting`、`choose_song`、`speech.priority_mapping` 下的 `copywriting`／`song` 和 `webui.show_card.common_config.choose_song`；从历史备份迁移时也应删除这些字段。原点歌命令按普通消息处理；普通回复 TTS、语音队列、`idle_time_task.copywriting` 提示、弹幕／回复模板和积分文案保留，历史 `data/`、`out/`、`song/` 素材及 `backup/` 不作修改。
- 原“弹幕过滤”已精简为“关键词屏蔽”，`filter` 只保留 `badwords.enable`、`discard`、`path`、`replace`。词库每行一个关键词，按区分大小写的字面子串匹配，不使用正则或拼音匹配；`discard: true` 丢弃命中内容，否则使用 `replace` 替换。用户名、输入和回复中的关键词检查保留；前后缀限制、表情和链接拦截、用户名黑名单、长度截断、限时去重与遗忘规则已移除，回复模板和模型自身的 Token 上限不受影响。
- 关键词屏蔽先于积分签到、查询、礼物和入场计分执行；丢弃时不会写入业务数据或生成积分回复，替换时各业务分支使用同一份清理后的内容。
- 队列设置已从过滤模块移到“音频播放”：统一使用 `speech.queue_capacity`、`speech.queue_start_threshold` 和 `speech.priority_mapping`。从历史配置迁移时，将原有效队列容量（旧 `speech.queue_capacity`、`filter.message_queue_max_len`、`filter.voice_tmp_path_queue_max_len` 的有效最小值）写入 `speech.queue_capacity`；把旧播放门槛、优先级分别移到后两个字段。完成后删除 `filter` 内除 `badwords` 外的字段及 `badwords.bad_pinyin_path`，旧路径不再读取。当前配置和恢复模板已完成迁移，队列容量保留为 50。
- 定时任务已切换到 `id`、`name`、`enable`、`run_on_start`、`interval`、`prompts`。当前配置及恢复模板已迁移，原提示文本、启停状态和间隔范围保留，其他配置不变。历史备份中的 `time_min` / `time_max` 可迁移为 `interval: { "mode": "random", "min": 原最短秒数, "max": 原最长秒数, "unit": "seconds" }`，`copy` 改为 `prompts`，补充唯一稳定的 `id`、任务名称及 `run_on_start` 后删除旧字段；旧结构会被明确拒绝，不再兼容直接复读。
- `GET /api/config` 返回脱敏值、强 ETag、`revision` 和受保护字段的 `readOnlyPaths`；`PUT /api/config` 必须携带读取时的 `If-Match: "<revision>"` 并提交完整配置草稿。缺失版本会以 `428` 拒绝；版本冲突时先保留草稿、重新载入最新版本再合并。`409 operator_bind_restart_required` 不是版本冲突：修改监听地址须编辑本机配置后重启，页面会保留草稿和修订版本。
- 更换 `login.ums_api` 的协议、主机或端口时，必须重新填写 `login.password`；不能将 `[REDACTED]` 代表的原密码转发到新服务。UMS 固定请求该地址来源的 `/auth/login`，仅更改未使用的路径不需要重新输入密码。
- `/settings` 根据服务端 `readOnlyPaths` 将外部程序、媒体播放器命令及独立 Live2D 的监听地址/端口显示为只读，远程 API 也会拒绝修改；这些字段须直接编辑受保护的磁盘配置后重载。未接入当前运行时的历史 TTS 模型选择和旧 WebUI 外观字段保留可见，但标注为不生效且只读。`reread`、`disabled` 模式下保留的 provider/model 不阻止其他配置保存。
- 操作台“重新载入”或 `POST /api/actions` 的 `reload` 会重新读取磁盘配置并重建运行组件，同时清除关键词词库缓存；修改同一路径词库后，无需重启即可通过重载生效。
- `--stdin` 下 `/restore`，或兼容 `/sys_cmd` 的 `factory`，从当前配置旁的 `.bak` 文件恢复。
- `restart` 由 `Scripts/start.bat`/`start.ps1` 监督；直接运行 `node dist/index.js` 时不要假设外部进程会自动拉起。

修改配置前先执行 `npm run backup`。真实密钥可能留在旧备份中，应限制文件权限并避免把新密钥提交到版本库。

`.gitignore` 只阻止后续误提交，不能删除 Git 历史中的凭据。本仓库历史已发现 API key、Token 等凭据记录，不能仅因当前模板为空就认为历史安全。发布前先撤销或轮换历史凭据，再按协作流程清理全部相关历史引用及旧发布包；历史改写和强制推送需要单独安排。可用 `gitleaks git . --log-opts=--all --redact=100` 复查，报告不得包含明文秘密。

### Pi Agent 网页搜索工具

在 `/settings` → **通用配置 → 联网搜索** 中选择 `tavily`、`exa`、`openai`、`zai` 或 `kimi`，填写该服务商的 **API Key** 后勾选“注册网页搜索工具”。主模型须使用 `agent.mode: "llm"` 并开启 `agent.tools`，且模型本身支持工具调用。不复用主模型密钥、环境变量或网页登录凭据；服务商账户须有对应接口权限与可用额度。

| 服务商 | 官方接口 | 模型 |
| --- | --- | --- |
| [Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search) | `https://api.tavily.com/search` | 无需配置 |
| [Exa](https://exa.ai/docs/reference/search) | `https://api.exa.ai/search`，同时请求正文 | 无需配置 |
| [OpenAI](https://developers.openai.com/api/docs/guides/tools-web-search) | `https://api.openai.com/v1/responses`，强制使用 `web_search` | 默认 `gpt-5.4-mini` |
| [Z.ai](https://docs.z.ai/api-reference/tools/web-search) | `https://api.z.ai/api/paas/v4/web_search`，使用 `search-prime` | 无需配置 |
| [Kimi](https://platform.kimi.com/docs/guide/use-web-search) | `https://api.moonshot.cn/v1/chat/completions`，完成 `$web_search` 内置工具调用 | 默认 `kimi-k2.6` |

- `search_online.provider` 选择服务商；`api_key` 启用时必填。密钥输入框遮蔽显示，配置 API 返回 `[REDACTED]`，同一服务商/端点的保存可保留原密钥。更换服务商或端点后须重新输入；界面切换服务商会清空旧密钥、端点和模型，避免误发凭据。本地配置文件仍保存明文密钥，勿提交或公开。
- `endpoint` 通常留空；需要区域端点或自建代理时填写**完整 API URL**，不是仅填写 Base URL，且不得把凭据放在 URL 中。`model` 只对 OpenAI/Kimi 生效，自定义模型必须支持对应的联网搜索工具。
- `search_online.enable` 启用时向 Pi Agent 注册 `online_search`，由 LLM 按需发起工具调用，不会在每条消息到达时自动搜索，也不要求“联网”“在线”等前缀。模型选择直接回答时，不调用搜索服务；关闭搜索或主模型工具能力后不可调用。复读模式不调用模型或搜索工具。
- 搜索工具接收 `query` 和可选 `count`；服务商、接口地址和密钥由操作员配置，模型不可覆盖。正文与来源链接作为 Pi 的 `toolResult` 消息返回给模型，由模型继续生成回答，不再改写用户输入或拼接额外提示词。输入过滤规则保持不变，搜索错误通过工具结果告知模型。
- 旧的 `keyword_enable`、`before_keyword` 和 `resp_template` 已移除，加载或保存带这些字段的配置会提示删除；`http_proxy` 和 `https_proxy` 继续用于搜索请求。
- 配置 `count` 是省略工具参数 `count` 时的来源数；`max_count` 可选，默认等于配置 `count`，并作为工具 Schema 和服务端共同执行的上限，范围 1–20。Tavily/Exa/Z.ai 返回不超过请求数量的结果；OpenAI/Kimi 按此数请求来源并返回一份综合摘要，实际引用数由模型决定。默认总搜索超时 60 秒，单次响应上限 1 MiB，单份正文上限 8,000 字符；缓存最多 100 项、有效期 5 分钟。Kimi 最多进行 5 轮请求，共用总超时。
- 不再抓取百度、Google、Bing 或 DuckDuckGo 搜索网页，也不再逐个下载结果 URL。旧 `engine`、`engine_id`、`endpoints` 及各搜索引擎端点字段已移除；恢复历史备份前请迁移该配置段。`config.example.json` 与 `config.example.json.bak` 默认选择 Tavily，保持禁用且密钥为空，须由用户填写后启用。

## 7. 直播平台与中转

当前仅开放 **本地 talk、Bilibili Web、Bilibili 开放平台**。平台状态由前后端共享目录统一定义；`stdin`、`manual` 仍是本地输入别名，不额外开放直播接入商。

- 根 `platform: "talk"` 使用本地输入，不连接外部直播平台。
- 将根 `platform` 设为 `bilibili-web` 时，在同名配置段填写 `room_id`；可选 `sessdata`（仅填写 Cookie 值）或完整 `cookie`。适配器会获取规范房间号、WBI 签名和弹幕服务器，并直接建立 Bilibili WebSocket 连接。
- 将根 `platform` 设为 `bilibili-platform` 时，在同名配置段填写 `ACCESS_KEY_ID`、`ACCESS_KEY_SECRET`、`APP_ID`、`ROOM_OWNER_AUTH_CODE`。适配器会管理开放平台项目的启动、20 秒项目心跳、30 秒 WebSocket 心跳、失效重建和结束。
- YouTube、Twitch 和“让弹幕飞”（`ordinaryroad_barrage_fly`）统一标为 **待完善**：平台下拉选项不可选择，相关配置和 `webui.show_card.common_config` 显示开关不可编辑或启用。已有参数及凭据原样保留，适配器实现也保留，不会自动连线。
- 后端同时校验选择与写入：保存待完善平台返回 `422 platform_pending`；修改其受保护配置返回 `403 platform_pending`，不改变文件或修订号。原样保留这些字段不妨碍其他配置保存，脱敏凭据会恢复为原值；实际启动和重载也不能通过平台注册入口启用待完善接入商。
- 已删除旧 `bilibili`/`bilibili2` 以及拼多多、1688、斗鱼、微信直播、淘宝、快手、抖音、TikTok、HNTV/HNYV 适配器；对应旧 `platform` 标识会被明确拒绝，不能通过通用中转回退重新启用。
- 自定义平台及通用 WebSocket 中转回退暂不开放；配置 `relay_mode`、`relay_ws_url`、`websocket_url`、`ws_url`、`endpoint` 或 `listen_url` 不能绕过平台可用范围。底层中转实现及其回环地址、令牌、Origin/Host 安全校验保留。

仅检查操作台或修复旧平台配置时，可使用 `--no-platform` 启动而不连接来源；若旧 `platform` 指向待完善接入商，页面会保留该值并提示先改选 talk 或 Bilibili，改选后才能保存。

## 8. 语音、媒体、输出与硬件

- 外部 TTS、GPT-SoVITS 等服务必须独立启动，并在配置中填写本机可访问的 URL。容器中的 `127.0.0.1` 指容器自身。
- `/settings` 的 Edge TTS“说话人”字段会通过受认证的 `GET /api/speech/edge/voices` 自动同步微软当前语音目录；同步失败时保留现有 `edge-tts.voice`，重新载入页面即可重试。
- 音频和图片路径仍相对项目根目录解析；`data/`、`models/`、`out/`、`song/`、`log/` 及历史媒体资源不会在迁移时自动改写。
- 当前主程序不加载根目录 `models/iic/` 的 SenseVoice/VAD 权重或 Whisper 缓存。没有外部旧版语音识别程序共用时可自行清理；角色模型位于 `Live2D/live2d-model/`，不要混淆。旧 Python 演示、Electron 预加载脚本和旧 GUI 静态文件不再随主程序分发。
- 图片由平台或 API 的图片事件直接提供给 Pi Agent。旧 `image_recognition.img_save_path`、摄像头/窗口目标、FFmpeg 参数和循环截图字段不再生效，提交配置时会被明确拒绝。
- 独立的百度/Google 翻译服务已移除，不再提供弹幕或回复的自动翻译，根 `translate` 配置也已删除；`bert_vits2.auto_translate` 是 TTS 服务自身的独立选项，继续保留。
- 普通回复语音和调用方显式提交的本地音频共用有界播放队列，不会绕过队列并发调用播放器；本地文件会在项目根目录内做规范路径、链接、格式和大小校验。
- 播放取消或超时后，队列会先停止并等待当前播放器退出，再删除临时音频和交接下一条；取消后才完成的 SVC 临时输出也会回收，本地音频原文件不会作为临时输出删除。
- `play_audio.enable: false` 会统一切换到无声输出，不会因图片回复、外部播放器或本地音频来源绕过该开关。
- `agent.mode` 为 `llm` 时，`thanks` 的三个开关分别控制入场、关注和礼物事件；启用后会把事件类型、用户名和信息内容封装在 `<system-notice>` 与 `<\system-notice>` 之间并写入对应用户的 Pi 会话，由 LLM 生成回复。
- `/settings` → 通用配置 → 定时任务提供任务卡片：可配置名称、启停、固定或随机间隔、秒/分钟/小时单位、启动时立即执行，以及多条多行提示词；支持添加、删除、统一保存、撤销和重新载入，无需编辑 JSON。任务标识由页面自动生成，重命名不会改变标识。启用任务须有非空提示词，间隔须为正数且最长不小于最短，页面与服务端共用校验。
- 定时任务与答谢、闲时任务共用 `system-notice` 通知链：每次随机选一条提示词，展开 `{time}`、`{user_num}`、`{last_username}` 与 `[选项1|选项2]`，封装为 `type: "schedule"` 的通知并交给根 LLM。会话标识为 `${platform}:schedule:${id}`，同一任务的连续触发使用同一会话，不同任务独立；只有模型回复进入正常回复及语音流程，提示词不直接播报。
- 定时任务仅在 `agent.mode: "llm"` 时运行；`reread`、`disabled` 模式暂停执行但保留配置。默认先等待一个间隔再首次触发，`run_on_start: true` 则在启动或配置重载时立即执行；后续间隔从上轮处理完成后计算。停止、停用和重载会取消旧计时器，多个定时任务不会并发堆积模型调用。
- 闲时任务复用上述答谢通知链：启用 `idle_time_task.enable` 并使用 `agent.mode: "llm"` 后，将选中的提示封装为 `type: "idle"`、`username: "闲时任务"` 的通知，写入当前平台的闲时任务 Pi 会话并触发模型回复。`copywriting`、`comment` 分别作为文案提示和话题提示，至少启用一组；多组轮流选取，组内保留顺序或随机轮换，支持 `{time}`、`{user_num}`、`{last_username}` 和 `[选项1|选项2]`。提示原文不直接播报，只有 LLM 生成的回复进入正常回复及语音流程；`reread`、`disabled` 模式不会生成闲时回复。
- 闲时任务的页面、API 和运行时共用校验：启用时至少一组启用的提示列表包含非空文本，队列阈值必须为非负整数，显式计时间隔换算后不得超过 `2,147,483,647` 毫秒，防止溢出变成高频触发。缺失或禁用的闲时配置保持不执行。
- 闲时本地音频模式已删除，从历史备份迁移时须移除 `idle_time_task.local_audio`；音频队列阈值和播放积压回调仍用于判断闲时触发时机，不代表支持闲时音频播放。
- `play_audio.info_to_callback` 的队列状态反馈在进程内直接传递，不再向自己的 HTTP `/callback` 发请求，因此启用操作台令牌不会导致内部反馈收到 401；外部协调服务回调仍独立处理。协调回调不会转发自己产生的失败状态，其他组件的状态事件仍按配置正常转发。
- 本地字幕只允许写入项目 `log/` 或 `out/` 下的 `.txt`、`.srt`、`.vtt`、`.ass`、`.ssa` 文件；写入端会解析符号链接再次校验目录，不能借字幕输出覆盖源码、配置或其他项目文件。
- 本地 TTS 参考音频默认只允许位于项目的 `data/`、`models/`、`out/`。确需额外目录时，用 `AI_VTUBER_REFERENCE_AUDIO_ROOTS` 配置 JSON 路径数组或系统路径分隔符列表；文件仍受 32 MiB、类型和符号链接检查。
- Live2D 由主程序按 `live2d.enable`/`live2d.host`/`live2d.port` 提供页面和 SSE；主机默认安全地绑定回环地址，容器对外提供时须显式设为 `0.0.0.0`。详见 `Live2D/README.md`。

### Live2D 预览、对话与实时虚拟摄像头

首页“角色预览与对话”直接显示 `live2d.name` 对应的可动模型，支持鼠标互动与自适应尺寸。输入框使用现有 `talk` 处理链，Enter 发送、Shift+Enter 换行；回复同步到窗口和模型字幕。智能回复需要在配置中心设置 `agent.mode: "llm"` 及模型凭据；无需模型凭据的联调可使用 `agent.mode: "reread"`。未启用 Agent 时不会伪造回复。

内置 Live2D 已升级为 **Cubism 5 SDK for Web R5**（配套 Core **06.00.0001**），支持 Cubism 5.3 模型，并兼容早期 Cubism 3/4 的 `.moc3` 模型；5.3 新增混合模式和离屏绘制需要 WebGL 2。模型仍按 `<name>/<name>.model3.json` 加载，完整保留导出资源的相对目录。构建与版本来源见 [Live2D/README.md](Live2D/README.md)；升级后刷新预览或 OBS 浏览器源。

1. 在本机安装 [OBS Studio](https://obsproject.com/download)（OBS 28+，带 obs-websocket v5、浏览器源与 OBS Virtual Camera），并启动 OBS。Windows 便携版需要管理员运行随附的 `data/obs-plugins/win-dshow/virtualcam-install.bat`，同时注册 32/64 位组件，然后重启 OBS。
2. 在 OBS“工具 → WebSocket 服务器设置”启用服务和密码认证。把密码填入 `live2d.camera.password`；端点默认是 `ws://127.0.0.1:4455`。后台仅接受本机回环地址；该地址属于凭据投递策略，只能修改磁盘配置后重载，不能从 WebUI 改向其他服务。
3. 在 OBS 虚拟摄像头设置中使用“程序/Program”输出类型。保持 OBS 暂未推流、录制或开启虚拟摄像头，再点击首页“启动虚拟摄像头”。后台建立专用 `AI Vtuber Live2D` 场景和浏览器源，默认以 **1280×720 / 30 fps** 输出，等待设备实际启用后才显示运行中。
4. 在直播伴侣、会议或直播平台软件中选择 **OBS Virtual Camera**。它只输出视频；TTS 声音需另外接入下方的虚拟麦克风。摄像头不保留透明通道，透明区域为黑色；OBS 浏览器源本身仍可用于透明叠加。后台不代替平台执行登录或开播。

`live2d.camera.width`、`height`、`fps` 控制输出尺寸和帧率；`auto_start: true` 可在应用启动时自动开启（OBS 必须已运行，Live2D 必须启用）。手动停止、配置重载和应用退出都会尝试关闭本应用开启的摄像头并恢复原场景与视频参数。已有推流/录制/摄像头输出或同名非本应用场景时会拒绝接管；运行期间离开专用场景会停止摄像头，避免继续输出其他画面。OBS 连接中断时状态会报错，无法确认关闭时请在 OBS 中手动停止。

WebUI 的 `/avatar/Live2D/` 使用同源 iframe；启用操作台令牌后，认证 API 签发短期、HttpOnly、仅限 `/avatar/` 的 Cookie，Bearer 令牌不会进入 iframe URL。独立渲染地址 `http://127.0.0.1:12345/Live2D/?camera=1` 供本机 OBS 使用，不包含控制台或字幕；请保持 Live2D 回环绑定，独立端口不提供操作台认证。

### 虚拟麦克风

`virtual_microphone.enable` 开启后，主程序会在保留原播放目标的同时，将合成得到的 TTS 音频并行播放到虚拟音频线的播放端；歌曲、报警音和其他本地音频不会进入虚拟麦克风。`play_audio.enable` 仍是总开关，必须保持开启。

先安装操作系统虚拟音频线（例如 Windows 上的 VB-CABLE）与 mpv，再运行 `mpv --audio-device=help` 获取虚拟音频线播放端的设备标识，将其填入 `virtual_microphone.device`。默认播放器参数使用 `--audio-device={device}` 定向输出；`executable` 和 `args` 属于本机执行策略，只能直接修改磁盘配置后重载。

```json
{
  "virtual_microphone": {
    "enable": true,
    "device": "wasapi/这里替换为 mpv 列出的虚拟音频线设备标识",
    "executable": "mpv",
    "args": [
      "--no-config",
      "--no-video",
      "--really-quiet",
      "--audio-device={device}",
      "--",
      "{audio}"
    ]
  }
}
```

旧 LLM 适配器若不能映射到 pi 提供方会直接失败，请改用 `agent.provider` 或 `openai-compatible`。

## 9. 数据迁移与 SQLite

迁移时原样保留 `config.local.json`、`config.local.json.bak`、`data/`、`models/`、`backup/`、`out/`、`song/`、`log/`、cookie/凭据和媒体目录。不要为了“清理安装”覆盖这些目录。

SQLite 使用 Node 22 内置驱动。数据库路径为 `database.path`，默认 `data/data.db`。以下任一功能需要数据库时会打开并迁移旧表：`database.enable=true`、任一 `database.comment_enable`/`entrance_enable`/`gift_enable=true`、`integral.enable=true` 或 `data_analysis.enable=true`；显式 `database.enable=false` 优先并禁止打开。迁移在事务中执行；旧表缺少必要列时会报不兼容，而不会清空重建。首次启用前应备份数据库及其 `-wal`/`-shm` 伴随文件。

积分账户优先按“平台 + 平台用户 ID”识别；适配器提供稳定用户 ID 时，用户修改昵称不会丢失余额，也不能通过改名重复领取当日签到或入场积分。旧版按用户名保存的每日奖励表会在同一事务中升级并关联已有账户。`bilibili-web` 的数字 UID 与 `bilibili-platform` 的 `open_id` 属于不同标识体系，切换适配器不会自动合并两侧已有积分，切换前应按实际账号关系迁移数据。

## 10. 运维脚本

```bash
# 创建 backup/YYYY-MM-DDTHH-MM-SS-mmmZ/
# 固定复制 config.local.json、可用的 config.local.json.bak、data/、out/；跳过符号链接
npm run backup

# 必须给出明确确认参数
npm run cleanup:demo -- --confirm-demo-cleanup

# 输出指定闲时音频子目录中的文件配置项（默认 ikaros）
npm run list:idle-audio -- ikaros
```

清理脚本不扫描目录、不使用通配符、不删除 `data/` 或日志。唯一允许删除的是以下历史 demo 输出（不存在时跳过）：

```text
out/copywriting/{test.wav,测试文案.mp3,测试文案.wav,测试文案2.wav,测试文案3.wav,达达利亚.wav,吐槽.wav,伊卡日语介绍.wav}
out/copywriting2/{test.wav,test2.wav}
out/本地问答音频/{关键词1.wav,关键词2.wav}
out/song/把回忆拼好给你.mp3
```

Windows 对应包装器为 `Scripts/6.备份配置和数据文件.bat` 和 `Scripts/5.删除demo数据.bat`。`Scripts/2.更新至主线版本（得先安装git）.bat` 只执行安全的 `git pull --ff-only`，有本地分叉时会停止，不会强制重置。

## 11. Docker

Dockerfile 使用本仓库根目录作为构建上下文：

```bash
docker build -t ai-vtuber .
```

构建只使用根目录 `.dockerignore` 的输入白名单，不再维护会覆盖它的 Dockerfile 专属忽略文件；递归排除 `.env`、凭据文件、私钥和已安装依赖，本机配置、数据、输出及日志也不会发送到构建器。镜像以非 root 用户运行，并保留本项目和 Pi 的许可证。先建立专用状态目录，将安全模板复制为 `config.local.json` 与 `config.local.json.bak`，再把整个目录挂载到 `/state`；配置保存采用原子替换，不能把单个配置文件直接挂成容器挂载点。运行前还需把 `webui.ip`（或回退的 `api_ip`）设为 `0.0.0.0`；启用 Live2D 时还要把 `live2d.host` 设为 `0.0.0.0`：

```bash
mkdir -p /absolute/path/ai-vtuber-state
cp config.example.json /absolute/path/ai-vtuber-state/config.local.json
cp config.example.json.bak /absolute/path/ai-vtuber-state/config.local.json.bak

docker run --rm --name ai-vtuber \
  -p 8081:8081 -p 8082:8082 -p 12345:12345 \
  --mount type=bind,src=/absolute/path/ai-vtuber-state,dst=/state \
  --mount type=bind,src=/absolute/path/AI-Vtuber/data,dst=/workspace/app/data \
  --mount type=bind,src=/absolute/path/AI-Vtuber/out,dst=/workspace/app/out \
  --mount type=bind,src=/absolute/path/AI-Vtuber/log,dst=/workspace/app/log \
  -e AI_VTUBER_OPERATOR_TOKEN=replace-me \
  ai-vtuber
```

`12345` 是默认的 Live2D 监听端口；只有启用 Live2D 并把 `live2d.host` 设为容器可达地址（Docker 中通常为 `0.0.0.0`）后，该映射才会对宿主机生效。如果 `live2d.port` 配置为其他值，必须把 `-p 12345:12345` 改为映射该配置端口（例如 `-p 23456:23456`）。

基础运行镜像已安装 FFmpeg；音频设备、GPU 仍须显式映射，宿主机上的本地模型、TTS 服务须使用容器可达地址。需要额外系统驱动或编解码器时再派生运行镜像。

## 12. 排障与验证

```bash
npm start -- --help
npm run typecheck
npm test

# config.example.json 使用 agent.mode=reread，并保持平台、TTS、音频输出和 Live2D 全部关闭；
# 此命令不启动 HTTP 服务或平台连接，也不调用模型/语音/硬件。
node --enable-source-maps dist/index.js --config config.example.json --no-server --no-platform --reread "本地烟测"
```

常见问题：

- **找不到内置 pi 或其构建产物**：确认仓库中的 `pi/` 完整存在，执行 `npm run install:pi` 后重试。
- **操作台返回 401**：在页面输入与环境变量/配置一致的令牌，API 请求使用 Bearer 头。
- **浏览器能打开但平台无事件**：先确认 `platform` 为已开放接入商，再检查 Bilibili 房间号、凭据及网络；可用 `--no-platform --manual` 隔离核心对话链路。YouTube、Twitch、“让弹幕飞”和自定义中转当前不开放，不能靠补填地址或密钥启用。
- **FFmpeg/设备不可用**：核对可执行路径、系统设备名称、权限与容器映射。
- **已合成音频但播放器立即退出**：Windows 先用 `where.exe ffplay` 检查 PATH 顺序，再对实际程序执行 `ffplay -version`。若命中失效的 Python 启动器而非原生 FFmpeg，在本机配置中将 `play_audio.executable` 设置为有效 `ffplay.exe` 的绝对路径；若配置了 `speech.player.executable`，后者优先。可执行路径属于只读安全策略，须修改磁盘配置后重载或重启，不能通过 WebUI 改写。
- **配置重载失败**：查看 SSE/日志中的组件错误；修复配置后再 reload，或从同目录 `config.local.json.bak` 恢复。
- **SQLite 不兼容**：不要删除原库；先保留数据库及 WAL/SHM，检查旧表列并从备份迁移。
