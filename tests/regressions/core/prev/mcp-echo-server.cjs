// Minimal stdio MCP server exposing one tool "echo".
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result;
  if (msg.method === "initialize")
    result = { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "echo", version: "1" } };
  else if (msg.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          description: "echo",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    };
  else result = { content: [{ type: "text", text: "echo:" + JSON.stringify(msg.params.arguments) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
});
