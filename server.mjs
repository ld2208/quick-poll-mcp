// Quick Poll — Cowork MCP Apps 示例服务器
// 实现 SEP-1865 的「模板/数据分离」：
//   1) create_poll 工具：只返回数据，并声明 _meta.ui.resourceUri 指向 ui:// 资源
//   2) cast_vote 工具：app-only（widget 才能调，Agent 看不到）
//   3) resources/read：返回自包含 HTML（mime: text/html;profile=mcp-app）
//
// 传输：Streamable HTTP（带 Mcp-Session-Id 会话），端点 POST/GET/DELETE /mcp

import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

const RESOURCE_URI = "ui://quick-poll/poll.html";

// ───────────────────────── 简易内存存储（演示用，真实环境换成数据库） ─────────────────────────
/** pollId -> { question, options:[], tallies:{ option: count } } */
const polls = new Map();

function makePoll(question, options) {
  const id = "poll_" + randomUUID().slice(0, 8);
  const tallies = {};
  for (const o of options) tallies[o] = 0;
  polls.set(id, { question, options, tallies });
  return id;
}

function pollPayload(id) {
  const p = polls.get(id);
  if (!p) return null;
  return { pollId: id, question: p.question, tallies: p.tallies };
}

function summarize(id) {
  const p = polls.get(id);
  const total = Object.values(p.tallies).reduce((a, b) => a + b, 0);
  const parts = Object.entries(p.tallies).map(([k, v]) => `${k}: ${v}`).join("、");
  return `投票「${p.question}」目前共 ${total} 票（${parts}）。`;
}

// ───────────────────────── widget 的 HTML（自包含，内联脚本/样式） ─────────────────────────
// 注意：iframe CSP 不允许加载外部 CDN/SDK，所以这里手写了一个最小的 postMessage 客户端，
// 不依赖任何外链。底部带一个 DEBUG 面板，首次部署时能直接看到 Cowork 与 widget 之间的原始消息。
const POLL_HTML = String.raw`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", sans-serif; margin: 0; padding: 16px; }
  h3 { margin: 0 0 12px; font-size: 16px; }
  .opt { margin: 8px 0; }
  button.vote {
    display:flex; justify-content:space-between; align-items:center;
    width:100%; padding:10px 12px; border:1px solid #c9c9c9; border-radius:8px;
    background:#f7f7f7; cursor:pointer; font-size:14px;
  }
  button.vote:hover { background:#eee; }
  .bar { height:6px; background:#0a7d5a; border-radius:3px; margin-top:4px; transition:width .25s; }
  .actions { margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; }
  .actions button {
    padding:8px 12px; border:1px solid #b9b9b9; border-radius:8px; background:#fff; cursor:pointer; font-size:13px;
  }
  #status { color:#888; font-size:13px; }
  details { margin-top:18px; }
  summary { cursor:pointer; color:#888; font-size:12px; }
  #dbg { white-space:pre-wrap; font-family:ui-monospace,Consolas,monospace; font-size:11px;
         max-height:160px; overflow:auto; background:#111; color:#9fe; padding:8px; border-radius:6px; }
</style>
</head>
<body>
  <h3 id="q">等待资料…</h3>
  <div id="status">（Widget 已挂载，正在等待投票数据）</div>
  <div id="opts"></div>

  <div class="actions">
    <button id="discuss">请 Agent 总结投票结果</button>
    <button id="full">全屏</button>
  </div>

  <details>
    <summary>DEBUG：原始消息（首次部署排错用）</summary>
    <div id="dbg"></div>
  </details>

<script>
(function () {
  var pending = new Map();
  var seq = 0;
  var pollId = null;

  function dbg(tag, obj) {
    var el = document.getElementById("dbg");
    if (!el) return;
    var line = tag + " " + (typeof obj === "string" ? obj : JSON.stringify(obj));
    el.textContent = line + "\n" + el.textContent;
  }

  // 监听来自宿主(Cowork)的消息
  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    dbg("⬇ IN", msg);

    // 1) 我们发出的请求的响应
    if (msg.id != null && pending.has(msg.id)) {
      var p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
      return;
    }

    // 2) tool-result 通知（挂载时宿主把工具结果推给 widget）
    var method = msg.method || "";
    if (method.indexOf("tool-result") >= 0 || method.indexOf("toolresult") >= 0) {
      var params = msg.params || {};
      // CallToolResult 可能是 params 本身，也可能嵌在 params.result
      var result = params.result || params;
      render(result);
    }
  });

  // 向宿主发 JSON-RPC 请求
  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      var payload = { jsonrpc: "2.0", id: id, method: method, params: params };
      dbg("⬆ OUT", payload);
      parent.postMessage(payload, "*");
      setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); }
      }, 15000);
    });
  }

  function render(result) {
    if (!result) return;
    var data = result.structuredContent || result;
    if (!data || !data.tallies) return;
    pollId = data.pollId || pollId;

    document.getElementById("status").style.display = "none";
    document.getElementById("q").textContent = data.question || "投票";

    var wrap = document.getElementById("opts");
    wrap.innerHTML = "";
    var entries = Object.keys(data.tallies).map(function (k) { return [k, data.tallies[k]]; });
    var total = entries.reduce(function (a, e) { return a + e[1]; }, 0) || 1;

    entries.forEach(function (e) {
      var choice = e[0], n = e[1];
      var div = document.createElement("div"); div.className = "opt";
      var btn = document.createElement("button"); btn.className = "vote";
      btn.innerHTML = "<span>" + choice + "</span><b>" + n + "</b>";
      btn.onclick = function () { vote(choice); };
      var bar = document.createElement("div"); bar.className = "bar";
      bar.style.width = (100 * n / total) + "%";
      div.appendChild(btn); div.appendChild(bar);
      wrap.appendChild(div);
    });
  }

  // 投票 → tools/call 回到你的服务器
  function vote(choice) {
    rpc("tools/call", { name: "cast_vote", arguments: { pollId: pollId, choice: choice } })
      .then(function (r) { render(r); })
      .catch(function (err) { dbg("✖ vote error", String(err && err.message || err)); });
  }

  // 把话交回给 Agent（注入到对话里）
  document.getElementById("discuss").onclick = function () {
    rpc("ui/message", { content: "请总结这个投票的结果，并给出场地建议。" })
      .catch(function (err) { dbg("✖ ui/message error", String(err && err.message || err)); });
  };

  // 切换全屏显示模式
  document.getElementById("full").onclick = function () {
    rpc("ui/request-display-mode", { mode: "fullscreen" })
      .catch(function (err) { dbg("✖ display-mode error", String(err && err.message || err)); });
  };

  dbg("● widget ready", "");
})();
</script>
</body>
</html>`;

// ───────────────────────── 构建一个 MCP Server 实例（每个会话一个） ─────────────────────────
function buildServer() {
  const server = new Server(
    { name: "quick-poll", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // tools/list：声明两个工具
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "create_poll",
        description: "创建一个互动投票 widget。给定问题和若干选项。",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "投票问题" },
            options: {
              type: "array", items: { type: "string" },
              description: "候选项列表",
            },
          },
          required: ["question", "options"],
        },
        _meta: {
          ui: { resourceUri: RESOURCE_URI }, // visibility 省略 → 默认 model+app
        },
      },
      {
        name: "cast_vote",
        description: "记录一票（仅供 widget 调用）。",
        inputSchema: {
          type: "object",
          properties: {
            pollId: { type: "string" },
            choice: { type: "string" },
          },
          required: ["pollId", "choice"],
        },
        _meta: {
          ui: { visibility: ["app"] }, // app-only：Agent 看不到，只有 widget 能调
        },
      },
    ],
  }));

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    if (name === "create_poll") {
      const question = String(args.question || "未命名投票");
      let options = Array.isArray(args.options) ? args.options.map(String) : [];
      if (options.length === 0) options = ["选项 A", "选项 B"];
      const id = makePoll(question, options);
      return {
        // 文本摘要：即使 widget 没渲染，Agent 也能据此推理（优雅降级）
        content: [{ type: "text", text: summarize(id) }],
        // 紧凑结构化数据：widget 挂载时读取（务必 < 64 KiB）
        structuredContent: pollPayload(id),
      };
    }

    if (name === "cast_vote") {
      const id = String(args.pollId || "");
      const choice = String(args.choice || "");
      const p = polls.get(id);
      if (!p) {
        return { isError: true, content: [{ type: "text", text: "找不到该投票。" }] };
      }
      if (!(choice in p.tallies)) p.tallies[choice] = 0;
      p.tallies[choice] += 1;
      return {
        content: [{ type: "text", text: "已记录一票。" }],
        structuredContent: pollPayload(id),
      };
    }

    return { isError: true, content: [{ type: "text", text: "未知工具：" + name }] };
  });

  // resources/list（可选，列出 widget 资源）
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: RESOURCE_URI,
        name: "Quick Poll widget",
        mimeType: "text/html;profile=mcp-app",
      },
    ],
  }));

  // resources/read：返回 widget 的 HTML
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== RESOURCE_URI) {
      throw new Error("未知资源：" + req.params.uri);
    }
    return {
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
          text: POLL_HTML,
          // csp / permissions 必须放在「资源」的 _meta.ui 上（放在工具上无效）
          _meta: {
            ui: {
              csp: { frameDomains: [] },       // 本例不嵌套外部 iframe
              permissions: ["clipboardWrite"], // 允许写剪贴板（演示，可删）
            },
          },
        },
      ],
    };
  });

  return server;
}

// ───────────────────────── Express + Streamable HTTP（带会话） ─────────────────────────
const app = express();
app.use(express.json({ limit: "4mb" }));

/** sessionId -> transport */
const transports = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // 新会话：握手
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { transports[sid] = transport; },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = buildServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: 没有有效的会话 ID" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET（SSE 流）和 DELETE（关闭会话）
async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("无效或缺失的会话 ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

// 健康检查
app.get("/", (_req, res) => res.send("Quick Poll MCP server 运行中。端点：/mcp"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Quick Poll MCP server 已启动：http://localhost:${PORT}/mcp`);
});
