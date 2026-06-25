# Quick Poll — Cowork MCP Apps 示例

一个**可直接部署**的 MCP Server，演示在 Microsoft 365 Copilot（Cowork）里渲染互动 widget（遵循 MCP Apps 扩展 SEP-1865）。

Agent 调 `create_poll` → Cowork 渲染投票 widget → 用户点选项 → widget 调 `cast_vote` 回到本服务器 → 票数实时更新。

---

## 一、本地跑起来

需要 Node.js ≥ 18.17。

```bash
cd quick-poll-mcp
npm install
npm start
```

看到 `Quick Poll MCP server 已启动：http://localhost:3000/mcp` 即成功。
MCP 端点是 **`/mcp`**（支持 POST/GET/DELETE）。

## 二、暴露成公网 HTTPS

Cowork 连接器要求一个公网可达、**HTTPS** 的地址。本地测试任选一种隧道：

```bash
# 方式 A：Cloudflare Tunnel
cloudflared tunnel --url http://localhost:3000

# 方式 B：ngrok
ngrok http 3000
```

会得到一个 `https://xxxx.trycloudflare.com` 之类的地址。
**你的 MCP URL = 该地址 + `/mcp`**，例如 `https://xxxx.trycloudflare.com/mcp`。

正式上线时部署到任意支持 Node 的平台（Azure App Service、Container Apps、Render、Fly.io 等），同样用 `https://你的域名/mcp`。

## 三、在 Cowork 里挂上连接器

1. 在 Copilot/Cowork 的连接器（自定义 MCP 服务器）设置里，新建一个连接器。
2. 服务器地址填上一步的 **`https://.../mcp`**。
3. 保存后，在对话里说：
   > 帮我建一个投票：团队团建去哪？选项：湖边、市区、线上
4. Agent 会调用 `create_poll`，下方应出现可点击的投票 widget。

## 四、测试要点（对照《作者指南》）

| 测试 | 预期 |
|---|---|
| 建投票后 | widget 渲染出问题 + 三个可点按钮 |
| 点某个选项 | 票数与进度条**实时变化**（证明 `tools/call` 在同一会话内往返到你的服务器） |
| 让 Agent 直接投票 | 应做不到——`cast_vote` 是 `visibility:["app"]`，Agent 看不到 |
| 点「请 Agent 总结投票结果」 | 通过 `ui/message` 把一句话注入对话，Agent 接着回复 |
| 万一 widget 没渲染 | Agent 仍能看到文本摘要「投票…目前共 N 票」（优雅降级） |
| 点「全屏」 | 通过 `ui/request-display-mode` 在 inline / fullscreen 间切换 |

## 五、首次部署排错：DEBUG 面板

widget 底部有个折叠的 **DEBUG** 区，会实时打印 widget 与 Cowork 之间收发的**原始消息**（`⬇ IN` / `⬆ OUT`）。

> ⚠️ 唯一需要现场确认的点：iframe ↔ 宿主 之间 `postMessage` 的 JSON-RPC 帧格式。
> 本示例按 SEP-1865 的方法名（`tools/call`、`ui/message`、`ui/notifications/tool-result`、`ui/request-display-mode`）手写了最小客户端，并对 tool-result 的几种可能结构都做了兼容。
> 第一次测试时，如果票数不更新或挂载没收到数据，**把 DEBUG 面板里的 `⬇ IN` 那几行原样发给我**，我据此把帧格式对齐到 Cowork 的实际实现即可（通常是 `params` 包裹层或 `ui/message` 参数名的小差异）。

## 六、关键约束（已在代码里遵守）

- 工具只返回**数据**，HTML 由 `resources/read` 提供，mime = `text/html;profile=mcp-app`。
- `ui://` URI ≤ 1024 字符；HTML 自包含，不加载任何外链（iframe CSP 不放行 `connectDomains`/`resourceDomains`）。
- `csp.frameDomains` / `permissions` 放在**资源**的 `_meta.ui` 上，不是工具上；权限键用驼峰 `clipboardWrite`。
- `structuredContent` 保持紧凑（< 64 KiB）；大数据应改为 widget 按需 `tools/call` 拉取。
- 有状态会话靠 `Mcp-Session-Id`，SDK 自动回贴，本服务器已按标准会话模式实现。

## 文件清单

```
quick-poll-mcp/
├── package.json     依赖与启动脚本
├── server.mjs       MCP 服务器 + 内联 widget（全部逻辑在这）
└── README.md        本文件
```
