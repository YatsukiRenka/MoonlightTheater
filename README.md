![月光剧场横幅](assets/banner.webp)

# 月光剧场 · Moonlight Theater

月光剧场是一个原创角色绘画提示词生成器。随机生成一套角色设定，锁住喜欢的细节，再单独重抽发型、服装、配色或姿势。调整满意后，复制中文或英文提示词，就能交给你常用的绘图工具。

## 使用

1. 在「创作台」选择风格分支、画风和探索度，点击「随机生成」。随机生成只重抽未锁定的项目。
2. 在「角色设计」锁定要保留的项目，点骰子重抽某一项，或点击当前设定手动输入或选择素材。新输入按字段去重后存入设计库。英文可以选填，留空时两种提示词都使用输入原文。
3. 在「完整提示词」直接编辑或复制文本。提示词跟随页面语言：中文页面生成中文提示词，英文和日文页面生成英文提示词。

在「设计库」可调整素材权重，导出包含手动条目的设计库 JSON。导入时选择合并或替换。合并时新增素材并保留同 ID 的本地条目及权重，手动条目按字段去重，当前角色、偏好和锁定项保留。替换时以文件中的素材、配置和手动条目为准，并生成新角色。创作台中央是角色的月亮，各项设定分列两侧，下方依次是生成设置、提示词和生图。生图默认隐藏，可在生成设置下方切换显示。

导航栏底部可切换深浅主题和页面语言（中文、English、日本語）。设计库素材只有中英两种文字，日文页面显示英文素材名。

舞台中央的月亮和背后的星空用 WebGL2 实时绘制：月面由当前种子生成，按配色方案着色，按绘制画风切换水彩、赛璐璐或网点渲染；每次随机生成，月亮经历一次朔望，星空转出星轨。浏览器不支持 WebGL2、开启「减少动态效果」或强制颜色模式时，页面退回静态的 CSS 月亮或停止动画，功能不受影响。

「历史记录」分为「提示词记录」和「生图记录」。提示词可恢复角色和编辑文本，恢复后生成使用当前设计库。输入种子可以按当前词库、设置和锁定项重新生成，重现时会跳过历史查重。生图记录保留生成用量，图片可保存在本机或 Google Drive。

### 历史导入与备份

- 「导出历史」会生成明文 `.mlhistory` 文件，包含提示词、关联素材和本地图片。云端生图记录导出本地缩略图和 Drive 文件引用，查看预览或原图时需重新解锁云图库。支持保存对话框的浏览器可以选择盘符、文件夹和文件名，其他浏览器沿用常规下载。日常历史数据库由浏览器用户配置管理，备份文件可保存到其他盘或网盘。 [浏览器保存对话框](https://developer.mozilla.org/docs/Web/API/Window/showSaveFilePicker)
- 「导入历史」会把备份合并到当前设备，同 ID 记录保留本地版本，导入结果受本机保留上限限制。默认保留 100 条提示词和 30 批生图，图片容量默认为 64 MiB。在「设置 → 历史设置」可直接填写图片容量并选 MB、GB 或 MiB，实际可用空间由浏览器决定。本地原图和已缓存的缩略图都计入容量。提示词条数或生图批数可设为 0。
- Drive 整库备份在浏览器中加密，每次产生一个独立版本，可用于恢复提示词和本地生图记录。恢复需要对应备份的口令。较大的本地图片库可用分批同步或导出到文件。生图 API Key、OAuth 令牌和资源设置留在当前浏览器。

在「历史设置 → Google Drive 备份」点「使用 Google 登录」，在 Google 弹窗选账号并授权。授权范围是 `drive.appdata`。在另一台设备登录同一个 Google 账号，可选择备份并输入原口令合并恢复。OAuth 访问令牌只保留在当前页面内存。整库备份和云图库仍各自使用加密口令。 [Drive 应用数据目录](https://developers.google.com/workspace/drive/api/guides/appdata) · [Google 浏览器 OAuth](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

站点维护者需在 Google Cloud 启用 Drive API，设置 OAuth 同意屏幕并创建 **Web 应用**客户端。把托管站点的来源加入客户端的「已获授权的 JavaScript 来源」。GitHub Pages 使用 `https://yatsukirenka.github.io`。将公开的 Client ID 存为仓库 Actions 变量 `MOONLIGHT_DRIVE_CLIENT_ID`，或在运行 `npm run build` 时提供这个环境变量。授权可用性由 Google Cloud 的用户范围设置决定。 [Google Web 客户端配置](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)

自建站点、或需要继续访问此前用个人 OAuth 客户端备份的数据时，可在「高级登录设置」选用原客户端。Drive 备份依附于最初授权的 OAuth 应用。 [Drive 应用数据目录](https://developers.google.com/workspace/drive/api/guides/appdata)

### 云端图库与按需加载

- 连接 Drive 后解锁「云端图库」，各设备使用同一个云图库口令。自动同步默认关闭，可设为每 1 至 1440 分钟运行（默认 15 分钟）。定时同步需要保持页面打开和 Drive 授权有效。授权到期后需重新连接并解锁。间隔长于授权剩余时间时，可以缩短间隔或者点「合并云端生图」手动同步。
- 同步只下载记录信息和最长边 320 像素的缩略图，已有缩略图可以离线浏览。点开图片时才加载最长边 1280 像素的预览图，点「查看原图」或「下载原图」才取回对应的原文件。缩略图和预览图保持宽高比，小图保持原尺寸，动图的两档预览使用静帧。
- 开启自动同步并解锁后，新图先保存原图，再在后台加密上传到 Drive。排队或上传时，会为原图保留空间，必要时可超过设置的保留上限。上传失败后，原图仍在本机，后续普通生图按本机保留上限正常轮换。每批云端原图通过完整性校验后，才会替换本地原图。要整理已有生图记录，可点「用缩略图替换本地原图」，也可以调整本机保留设置。
- 云端同步先读取最近生成的批次。本机独有的原图优先保留，同步下载的缩略图使用剩余容量。
- 清理本地历史时，云端副本会继续占用 Drive 空间。如需清空云端，从 Google Drive 的「设置 → 管理应用」找到用于授权的应用并删除隐藏应用数据。这会同时移除云图库和整库备份。 [Drive 应用数据目录](https://developers.google.com/workspace/drive/api/guides/appdata)

## 本地运行

下载或克隆仓库，在包含 `index.html` 的目录运行以下命令（需要 Python 3）。

```bash
python -c "import http.server as s; s.SimpleHTTPRequestHandler.extensions_map['.mjs'] = 'text/javascript'; s.test(HandlerClass=s.SimpleHTTPRequestHandler, port=8000, bind='127.0.0.1')"
```

Windows 可能把 `.mjs` 识别为纯文本，导致脚本无法加载。

浏览器打开 <http://127.0.0.1:8000> 即可使用创作台。整个应用都由静态文件提供，提示词生成无需 API Key。

## 图片生成

打开本地地址或已发布的站点，在「设置 → 添加 API 资源」选择接口类型，填写 API Key 或 OAuth 配置。点击「验证并获取模型」，从供应商返回的列表选好默认模型后保存。同一类型可保存多条资源，名称可用来区分不同账号或网关。返回创作台，选择资源和模型，使用当前的中英文提示词生成图片。

「高级图像设置」根据所选模型提供参数。点击生成按钮左边的图标可添加多张 PNG、JPEG 或 WebP 参考图。参考图在当前页面中预览，点击生成时由浏览器直接发给所选接口。多图结果以卡片叠放，图框随当前图片的宽高比调整。点击当前图可打开同批图片的放大预览。两个视图都支持左右按钮、键盘方向键和手机横向滑动，下载按钮对应当前显示的图片。

| 模型 | 设置差异 |
| --- | --- |
| GPT Image 2.6 Sunburst / Flare | 支持复杂度、自定义分辨率和 `xhigh`、`max`。可按项目权限使用 SVG 或 GIF。GIF 可设帧数及延迟，SVG 限单张并使用文生图。 |
| GPT Image 2.5 Sunburst / Flare | 支持自定义分辨率、`xhigh`、`max` 和参考图标注。 |
| GPT Image 2 | 支持自定义分辨率，画质最高 `high`，透明背景为供应商预览功能。 |
| GPT Image 1.5 / 1 Mini | 支持固定尺寸和 `low`、`medium`、`high`。1.5 允许选参考图保真度。 |
| Nano Banana 2.1 | 1K、2K、4K，思考档位「最少／中／高」，支持网页和图片搜索辅助。 |
| Nano Banana 2 | 512、1K、2K、4K，思考档位「最少／高」，支持网页和图片搜索辅助。 |
| Nano Banana 2 Lite | 1K，思考档位「最少／高」。 |
| Nano Banana Pro | 1K、2K、4K，模型自动思考，可使用网页搜索辅助。 |
| Nano Banana | 固定输出分辨率，支持常用画幅。 |

OpenAI 的静态图支持 JPEG/WebP 压缩，并可显示最多三张流式预览。Gemini 多图与启用流式预览的 OpenAI 多图采用分次请求，各次单独计费。Gemini 官方接口可选返回图文或仅图片，Vertex 可设置输出格式和人像生成选项。 [OpenAI 生图指南](https://developers.openai.com/api/docs/guides/image-generation) · [Gemini Nano Banana 生图指南](https://aistudio.google.com/docs/image-generation) · [Vertex AI 生图指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/image-generation)

验证使用供应商的模型列表接口。验证成功说明接口接受了凭据并返回了模型，实际生图仍取决于供应商的模型权限、账单和配额。

生图结果和历史会显示请求耗时、供应商报告的 Token 总数与费用。优先显示接口返回的实际费用，其次按配置时取得的模型单价估算。OpenAI 与 Google 的官方模型目录没有标准价格字段，已知型号按公开标准价估算。缺少用量或可用单价时会直接标明。 [OpenAI 价目表](https://developers.openai.com/api/docs/pricing) · [Gemini 价目表](https://aistudio.google.com/docs/pricing) · [Vertex AI 价目表](https://cloud.google.com/model-garden/pricing)

API Key 和接口配置保存在当前浏览器按网页来源划分的本地存储中。每条资源可单独编辑和删除。编辑原接口时，密钥栏留空可沿用已经保存的密钥。修改自定义接口的站点或兼容协议时需重新填写。Google 访问令牌只保留在当前页面内存，刷新后需重新授权。已有单条配置会在同一来源下作为独立资源载入。改用其他来源、换设备或清除浏览器数据后，需要重新添加资源。

月光剧场的托管服务只提供静态文件。浏览器直接将生图请求和认证信息发送给所选供应商。若需要使用自己核验过的网页代码，可以用上面的本地启动方式。

### 官方 API

| 设置项 | 模型列表 |
| --- | --- |
| OpenAI · API Key | OpenAI Models API 返回的 GPT Image 模型 |
| Gemini · API Key | Gemini Developer API 返回的 Gemini 生图模型 |

OpenAI 公布的「Sign in with ChatGPT」预览明确排除图片生成工具。GPT 生图使用 OpenAI Images API Key，并受 API 项目的模型权限和账单约束。 [OAuth 能力限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate) · [Gemini 生图](https://ai.google.dev/gemini-api/docs/image-generation)

### Gemini 的 Google OAuth

1. 在 Google Cloud 项目中启用 Vertex AI API（`aiplatform.googleapis.com`）并设置账单。给登录账号授予 **Vertex AI User**（`roles/aiplatform.user`）或同等的模型调用权限。
2. 配置 OAuth 同意屏幕，创建 **Web 应用**类型的 OAuth 客户端。添加「Gemini · Google OAuth」资源时，复制当前站点的来源，添加到该客户端的「已获授权的 JavaScript 来源」。如果同意屏幕处于测试模式，把登录账号加入测试用户。
3. 在同一条资源填写项目 ID 或编号和 Client ID，点击「授权并获取模型」，再选模型并保存。浏览器通过 Google Identity Services 获取 `https://www.googleapis.com/auth/cloud-platform` 范围内的访问令牌，并请求 Vertex AI 模型目录。模型列表和生图使用所填 Cloud 项目的权限与配额。

[Google 浏览器 OAuth Token 流程](https://developers.google.com/identity/oauth2/web/guides/use-token-model) · [Google Cloud Gemini 生图](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/image-generation)

### 自定义接口

| 设置项 | 配置 |
| --- | --- |
| 完整接口地址 | 填写外部 HTTPS 或本机回环 HTTP 地址。OpenAI 格式示例为 `https://gateway.example/v1/images/generations`。Gemini 格式示例为 `https://gateway.example/v1beta/models/{model}:generateContent`，`{model}` 会替换为所选模型。 |
| 兼容协议 | OpenAI Images 接收 `data[].b64_json` 或 `data[].url`。Gemini 接收 `candidates[].content.parts[].inlineData`。 |
| 网关 API Key | 可选。OpenAI 格式使用 Bearer，Gemini 格式使用 `x-goog-api-key`。 |
| 模型列表地址 | 选填。默认从标准生图地址推导，其他路径可填写与生图接口同源的 GET 接口。 |
| 参考图编辑地址 | OpenAI 兼容协议可选。默认从 `/images/generations` 推导 `/images/edits`，其他路径可填写与生图接口同源的地址。Gemini 兼容协议在生图请求中内联参考图。 |
| 默认模型 | 验证后从网关返回的列表选择。创作台也可在同一列表切换。 |

自定义网关需要允许当前站点通过浏览器 CORS 调用生图与模型列表。填写网关密钥时，所选的模型列表接口需要拒绝匿名请求，才能校验密钥。网关返回图片链接时，图片服务器也需要允许浏览器读取，或由网关直接返回 Base64 图片。

网关可在模型记录的 `pricing` 提供明确的 `currency` 和价格单位，支持 `per_image`、`per_token`、`per_million_tokens`。按 Token 计价需同时提供 `input` 与 `output`，按张计价提供 `output` 或数值字段 `per_image`。

接口和预览交互参考了 [AI Image Workbench](https://github.com/zengliny/ai-image-workbench)、[LibreChat](https://github.com/LibreChat-AI/docs/blob/main/content/docs/features/image_gen.mdx) 和 [Image Studio](https://github.com/koppkvn/image-gen-open-source)。

## GitHub Pages 部署

首次部署时，在仓库「Settings → Pages → Build and deployment」将来源设为 **GitHub Actions**。工作流在 PR 中运行测试和静态构建，在 `main` 更新后发布 `dist/`。也可在 Actions 页面从 `main` 手动运行部署。 [GitHub Pages 发布源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

本仓库的项目站点地址是 `https://yatsukirenka.github.io/MoonlightTheater/`，与同一账号下使用默认域名的其他 Pages 站点共用 `https://yatsukirenka.github.io` 这个来源。浏览器按来源划分存储，`/MoonlightTheater/` 和同源的其他路径共用 `localStorage` 和 `IndexedDB`。其他同源站点的脚本可读取 `localStorage` 中的明文 API Key 和提示词记录，以及 `IndexedDB` 中的生图记录。 [GitHub Pages 站点类型](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

站点页脚链接至[隐私政策](https://yatsukirenka.github.io/MoonlightTheater/privacy.html)和[服务条款](https://yatsukirenka.github.io/MoonlightTheater/terms.html)，两页均提供中文、英文和日文版本。

OAuth 客户端（包括 Drive 备份）的「已获授权的 JavaScript 来源」和网关的 CORS 允许项均使用 `https://yatsukirenka.github.io`。为项目站点配置独立的自定义域名后，应用将拥有单独的来源，这两项也需改为该自定义域名对应的来源。

## 开源许可

Copyright © 2026 Yatsuki Renka

本项目采用 [GNU Affero General Public License v3.0 only](LICENSE)（AGPL-3.0-only）。如需另行商议闭源授权，可通过 [GitHub](https://github.com/YatsukiRenka) 联系作者。

页面字体为 Noto Serif SC 与 Cormorant Garamond 的子集，按 SIL Open Font License 1.1 授权，许可文本与子集说明见 `assets/fonts/`。
