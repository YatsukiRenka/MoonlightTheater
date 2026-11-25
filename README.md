![月光剧场横幅](assets/banner.webp)

# 月光剧场 · Moonlight Theater

月光剧场是一个原创角色绘画提示词生成器。随机生成一套角色设定，锁住喜欢的细节，再单独重抽发型、服装、配色或姿势。调整满意后，复制中文或英文提示词，就能交给你常用的绘图工具。

## 使用

1. 在「创作台」选择风格分支、画风和探索度，点击「随机生成」。
2. 在「角色设计」锁定要保留的项目，点骰子重抽某一项，或点击当前设定手动输入或选择素材。新输入按字段去重后存入设计库。英文可以选填，留空时两种提示词都使用输入原文。
3. 在「完整提示词」切换中英文，直接编辑或复制文本。

在「设计库」可调整素材权重，导出包含手动条目的设计库 JSON。导入时选择合并或替换。合并时新增素材并保留同 ID 的本地条目及权重，手动条目按字段去重，当前角色、偏好和锁定项保留。替换时以文件中的素材、配置和手动条目为准，并生成新角色。宽屏创作台左侧是角色设计和提示词，右侧是生图，可在「生成设置」切换显示。

「历史记录」分为「提示词记录」和「生图记录」。提示词可恢复角色和编辑文本，恢复后生成使用当前设计库。输入种子可以按当前词库、设置和锁定项重新生成，重现时会跳过历史查重。生图记录保留原图和生成用量。

### 历史导入与备份

- 「导出历史」会生成包含提示词、关联素材和生图原图的明文 `.mlhistory` 文件。支持保存对话框的浏览器可以选择盘符、文件夹和文件名，其他浏览器沿用常规下载。日常历史数据库由浏览器用户配置管理，备份文件可保存到其他盘或网盘。 [浏览器保存对话框](https://developer.mozilla.org/docs/Web/API/Window/showSaveFilePicker)
- 「导入历史」会把备份合并到当前设备，同 ID 记录保留本地版本，导入结果受本机保留上限限制。默认保留 100 条提示词、30 批生图及 64 MiB 原图，可在「设置 → 历史设置」分别调整。提示词条数或生图批数可设为 0。
- Drive 备份会在浏览器中加密当前设备的本地历史，每次备份生成一个独立版本。生图 API Key、OAuth 令牌和资源设置留在当前浏览器。恢复需要对应备份的口令，请自行保管。

连接 Google Drive 时，在 Google Cloud 项目启用 Drive API，设置 OAuth 同意屏幕并创建 **Web 应用**客户端。把「历史设置 → Google Drive 备份」显示的 JavaScript 来源加入客户端配置。若应用处于测试模式，把自己的账号加入测试用户。填写 Client ID 并连接，授权范围为 `drive.appdata`。在另一台设备使用同一个 Client ID 和 Google 帐号，可选取备份并输入原口令合并恢复。应用数据目录从 Drive 网页中隐藏，版本列表在月光剧场内查看。 [Drive 应用数据目录](https://developers.google.com/workspace/drive/api/guides/appdata) · [Google 浏览器 OAuth](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

## 本地运行

下载或克隆仓库，在包含 `index.html` 的目录运行以下命令（需要 Python 3）。

```bash
python -m http.server 8000 --bind 127.0.0.1
```

浏览器打开 <http://127.0.0.1:8000> 即可使用创作台。整个应用都由静态文件提供，提示词生成无需 API Key。

## 图片生成

打开本地地址或已发布的站点，在顶部「设置」填写生图资源。点击「验证并获取模型」，从供应商返回的列表选好默认模型后保存。已有资源可留空沿用密钥，再获取一次模型。返回创作台即可从下拉列表选择接口、模型和画幅，使用当前的中英文提示词生成图片。

「高级图像设置」根据所选模型提供参数。点击生成按钮左边的图标可添加多张 PNG、JPEG 或 WebP 参考图。参考图在当前页面中预览，点击生成时由浏览器直接发给所选接口。多图结果可左右切换，手机可在图上横向滑动，键盘可用方向键。点击当前图放大，下载按钮对应当前这一张。

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

API Key 和接口配置只保存在当前浏览器的本地存储。换设备或清除浏览器数据后需重新填写。编辑时，密钥栏留空会保留原值。「移除配置」会删除浏览器中的资源。Google 访问令牌只保留在当前页面内存，刷新后需重新授权。

月光剧场的托管服务只提供静态文件。浏览器直接将生图请求和认证信息发送给所选供应商。若需要使用自己核验过的网页代码，可以用上面的本地启动方式。

### 官方 API

| 设置项 | 模型列表 |
| --- | --- |
| OpenAI · API Key | OpenAI Models API 返回的 GPT Image 模型 |
| Gemini · API Key | Gemini Developer API 返回的 Gemini 生图模型 |

OpenAI 公布的「Sign in with ChatGPT」预览明确排除图片生成工具。GPT 生图使用 OpenAI Images API Key，并受 API 项目的模型权限和账单约束。 [OAuth 能力限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate) · [Gemini 生图](https://ai.google.dev/gemini-api/docs/image-generation)

### Gemini 的 Google OAuth

1. 在 Google Cloud 项目中启用 Vertex AI API（`aiplatform.googleapis.com`）并设置账单。给登录账号授予 **Vertex AI User**（`roles/aiplatform.user`）或同等的模型调用权限。
2. 配置 OAuth 同意屏幕，创建 **Web 应用**类型的 OAuth 客户端。从「设置 → Gemini · Google OAuth」复制当前站点的来源，添加到该客户端的「已获授权的 JavaScript 来源」。如果同意屏幕处于测试模式，把登录账号加入测试用户。
3. 在同一张设置卡片填写项目 ID 或编号和 Client ID，点击「授权并获取模型」，再选模型并保存。浏览器通过 Google Identity Services 获取 `https://www.googleapis.com/auth/cloud-platform` 范围内的访问令牌，并请求 Vertex AI 模型目录。模型列表和生图使用所填 Cloud 项目的权限与配额。

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

### Sites 托管

使用 `npm run build` 将静态资源打包到 `dist/`。Sites 的 ChatGPT 登录控制页面访问，生图资源由各设备的浏览器保存。

## 开源许可

Copyright © 2026 Yatsuki Renka

本项目采用 [GNU Affero General Public License v3.0 only](LICENSE)（AGPL-3.0-only）。如需另行商议闭源授权，可通过 [GitHub](https://github.com/YatsukiRenka) 联系作者。
