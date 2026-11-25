![月光剧场横幅](assets/banner.webp)

# 月光剧场 · Moonlight Theater

月光剧场是一个原创角色绘画提示词生成器。随机生成一套角色设定，锁住喜欢的细节，再单独重抽发型、服装、配色或姿势。调整满意后，复制中文或英文提示词，就能交给你常用的绘图工具。

## 使用

1. 在「创作台」选择风格分支、画风和探索度，点击「随机生成」。
2. 在「角色设计」锁定要保留的项目，点骰子重抽某一项，或手动选择素材。
3. 在「完整提示词」切换中英文，直接编辑、复制文本，或导出角色 JSON。

「素材库」支持调整抽取权重和导入、导出配置。「历史记录」会在当前浏览器中保存最近 100 条设定，可以恢复角色和编辑过的提示词。输入种子可以按当前词库、设置和锁定项重新生成，重现时会跳过历史查重。

## 本地运行

下载或克隆仓库，在包含 `index.html` 的目录运行以下命令（需要 Python 3）。

```bash
python -m http.server 8000 --bind 127.0.0.1
```

浏览器打开 <http://127.0.0.1:8000> 即可使用创作台。整个应用都由静态文件提供，提示词生成无需 API Key。

## 图片生成

打开本地地址或已发布的站点，在顶部「设置」保存生图资源，再回创作台选择接口、模型和画幅，点击「使用当前提示词生成」。浏览器会用编辑框里当前显示的中英文提示词请求所选供应商。结果支持放大和下载，生成费用与配额由供应商管理。

API Key 和接口配置只保存在当前浏览器的本地存储。换设备或清除浏览器数据后需重新填写。编辑时，密钥栏留空会保留原值。「移除配置」会删除浏览器中的资源。Google 访问令牌只保留在当前页面内存，刷新后需重新授权。

月光剧场的托管服务只提供静态文件。浏览器直接将生图请求和认证信息发送给所选供应商。若需要使用自己核验过的网页代码，可以用上面的本地启动方式。

### 官方 API

| 设置项 | 接口 | 默认模型 |
| --- | --- | --- |
| OpenAI · API Key | OpenAI Images API | `gpt-image-2` |
| Gemini · API Key | Gemini Developer API | `gemini-3.1-flash-image` |

OpenAI 公布的「Sign in with ChatGPT」预览明确排除图片生成工具。GPT 生图使用 OpenAI Images API Key，并受 API 项目的模型权限和账单约束。 [OAuth 能力限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate) · [Gemini 生图](https://ai.google.dev/gemini-api/docs/image-generation)

### Gemini 的 Google OAuth

1. 在 Google Cloud 项目中启用 Vertex AI API（`aiplatform.googleapis.com`）并设置账单。给登录账号授予 **Vertex AI User**（`roles/aiplatform.user`）或同等的模型调用权限。
2. 配置 OAuth 同意屏幕，创建 **Web 应用**类型的 OAuth 客户端。从「设置 → Gemini · Google OAuth」复制当前站点的来源，添加到该客户端的「已获授权的 JavaScript 来源」。如果同意屏幕处于测试模式，把登录账号加入测试用户。
3. 在同一张设置卡片填写项目 ID 或编号和 Client ID，保存后点击「使用 Google 登录」。浏览器通过 Google Identity Services 请求 `https://www.googleapis.com/auth/cloud-platform` 范围内的访问令牌，生图使用所填 Cloud 项目的 Vertex AI 配额。

[Google 浏览器 OAuth Token 流程](https://developers.google.com/identity/oauth2/web/guides/use-token-model) · [Google Cloud Gemini 生图](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/image-generation)

### 自定义接口

| 设置项 | 配置 |
| --- | --- |
| 完整接口地址 | 填写外部 HTTPS 或本机回环 HTTP 地址。OpenAI 格式示例为 `https://gateway.example/v1/images/generations`。Gemini 格式示例为 `https://gateway.example/v1beta/models/{model}:generateContent`，`{model}` 会替换为所选模型。 |
| 兼容协议 | OpenAI Images 接收 `data[].b64_json` 或 `data[].url`。Gemini 接收 `candidates[].content.parts[].inlineData`。 |
| 网关 API Key | 可选。OpenAI 格式使用 Bearer，Gemini 格式使用 `x-goog-api-key`。 |
| 默认模型 ID | 可选。可在创作台为单次使用覆盖模型 ID。 |

自定义网关需要允许当前站点来源通过浏览器 CORS 规则调用。如果网关返回的是图片链接，图片服务器也需要允许读取，或由网关直接返回 Base64 图片。

接口和预览交互参考了 [AI Image Workbench](https://github.com/zengliny/ai-image-workbench)、[LibreChat](https://github.com/LibreChat-AI/docs/blob/main/content/docs/features/image_gen.mdx) 和 [Image Studio](https://github.com/koppkvn/image-gen-open-source)。

### Sites 托管

使用 `npm run build` 将静态资源打包到 `dist/`。Sites 的 ChatGPT 登录控制页面访问，生图资源由各设备的浏览器保存。

## 开源许可

Copyright © 2026 Yatsuki Renka

本项目采用 [GNU Affero General Public License v3.0 only](LICENSE)（AGPL-3.0-only）。如需另行商议闭源授权，可通过 [GitHub](https://github.com/YatsukiRenka) 联系作者。
