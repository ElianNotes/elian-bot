// protocol.js — a tiny MCP stdio server: newline-delimited JSON-RPC 2.0 over
// stdin/stdout. No SDK dependency.
// Logging goes to stderr ONLY — stdout is the protocol channel.

const PROTOCOL_VERSION = "2024-11-05";

function makeServer({ name, version, tools }) {
  // tools: [{ name, description, inputSchema, handler(args) -> Promise<resultText|object> }]
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  function send(stream, msg) {
    stream.write(JSON.stringify(msg) + "\n");
  }
  const log = (...a) => process.stderr.write("[elianbot-mcp] " + a.join(" ") + "\n");

  async function handle(req, out) {
    const { id, method, params } = req;
    const reply = (result) => send(out, { jsonrpc: "2.0", id, result });
    const fail = (code, message) => send(out, { jsonrpc: "2.0", id, error: { code, message } });

    try {
      if (method === "initialize") {
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name, version },
          capabilities: { tools: {} }
        });
      }
      if (method === "notifications/initialized" || method === "initialized") {
        return; // notification — no response
      }
      if (method === "tools/list") {
        return reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        });
      }
      if (method === "tools/call") {
        const tool = toolMap.get(params && params.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params && params.name}`);
        try {
          const result = await tool.handler((params && params.arguments) || {});
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return reply({ content: [{ type: "text", text }] });
        } catch (err) {
          // Tool-level error: report as an error result, not a protocol error.
          return reply({
            content: [{ type: "text", text: `Error: ${err && err.message ? err.message : err}` }],
            isError: true
          });
        }
      }
      if (id != null) return fail(-32601, `Method not found: ${method}`);
    } catch (err) {
      log("handler crash:", err && err.message);
      if (id != null) fail(-32603, "Internal error");
    }
  }

  // Drive the loop over a readable (stdin) and writable (stdout).
  function listen(input = process.stdin, output = process.stdout) {
    let buf = "";
    input.setEncoding("utf-8");
    input.on("data", async (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch { log("bad JSON line ignored"); continue; }
        await handle(req, output);
      }
    });
    input.on("end", () => process.exit(0));
    log(`${name} v${version} ready (stdio)`);
  }

  return { listen, handle };
}

module.exports = { makeServer, PROTOCOL_VERSION };
