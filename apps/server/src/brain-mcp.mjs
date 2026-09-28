/**
 * Stdio MCP facade for the Brain HTTP API. Pi plans; this process only
 * forwards search, read-source, save-note and link calls.
 */
const port = process.env.XILING_PORT || "4317";
const origin = `http://127.0.0.1:${port}`;

const tools = [
  { name: "brain_search", description: "搜索笔记、聊天片段、论文、图表、报告和科研图实体", inputSchema: { type: "object", properties: { projectId: { type: "string" }, query: { type: "string" } }, required: ["projectId", "query"] } },
  { name: "brain_read_source", description: "读取科研图实体对应的来源正文", inputSchema: { type: "object", properties: { projectId: { type: "string" }, entityId: { type: "string" } }, required: ["projectId", "entityId"] } },
  { name: "brain_save_note", description: "保存 Wiki 笔记", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, markdown: { type: "string" }, pageId: { type: "string" } }, required: ["projectId", "title", "markdown"] } },
  { name: "brain_link", description: "建立科研图关系；正式结论进入待决定队列", inputSchema: { type: "object", properties: { projectId: { type: "string" }, kind: { type: "string" }, sourceId: { type: "string" }, targetId: { type: "string" }, summary: { type: "string" } }, required: ["projectId", "kind", "sourceId", "targetId"] } },
];

async function callTool(name, args) {
  if (name === "brain_search") {
    const response = await fetch(`${origin}/api/v1/brain/search?projectId=${encodeURIComponent(args.projectId)}&q=${encodeURIComponent(args.query)}`);
    return response.json();
  }
  if (name === "brain_read_source") {
    const response = await fetch(`${origin}/api/v1/brain/sources/${encodeURIComponent(args.entityId)}?projectId=${encodeURIComponent(args.projectId)}`);
    return response.json();
  }
  if (name === "brain_save_note") {
    const response = await fetch(`${origin}/api/v1/brain/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
    return response.json();
  }
  if (name === "brain_link") {
    const response = await fetch(`${origin}/api/v1/brain/relations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
    return response.json();
  }
  throw new Error(`Unknown Brain tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const decoder = new TextDecoder();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.decode(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    void handle(message);
  }
});

async function handle(message) {
  const id = message.id;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "xiling-brain", version: "0.1.0" } } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const value = await callTool(message.params?.name, message.params?.arguments ?? {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
    } catch (error) {
      send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } });
    }
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}
