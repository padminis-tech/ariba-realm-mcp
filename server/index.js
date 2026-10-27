import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as http from "http";

// ── Ariba config ──────────────────────────────────────────────────────────
const ARIBA = {
  baseUrl:      process.env.ARIBA_BASE_URL      || "https://openapi.ariba.com",
  tokenUrl:     process.env.ARIBA_TOKEN_URL     || "https://api.ariba.com/v2/oauth/token",
  clientId:     process.env.ARIBA_CLIENT_ID     || "",
  clientSecret: process.env.ARIBA_CLIENT_SECRET || "",
  apiKey:       process.env.ARIBA_API_KEY       || "",
  realm:        process.env.ARIBA_REALM         || "",
};
const ready = !!(ARIBA.clientId && ARIBA.clientSecret && ARIBA.apiKey && ARIBA.realm);
console.log(ready
  ? `[Ariba MCP] Ready — realm: ${ARIBA.realm}`
  : "[Ariba MCP] WARNING: credentials not set — set env vars before testing"
);

// ── Token cache ───────────────────────────────────────────────────────────
let _token = "", _exp = 0;
async function getToken() {
  if (_token && Date.now() < _exp - 60_000) return _token;
  const creds = Buffer.from(`${ARIBA.clientId}:${ARIBA.clientSecret}`).toString("base64");
  const r = await fetch(ARIBA.tokenUrl, {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`Token request failed (${r.status}): ${await r.text()}`);
  const d = await r.json();
  _token = d.access_token;
  _exp   = Date.now() + (d.expires_in || 3600) * 1000;
  return _token;
}

// ── Ariba GET helper ──────────────────────────────────────────────────────
async function aribaGet(apiPath, extra = {}) {
  if (!ready) throw new Error("Ariba credentials not configured.");
  const token  = await getToken();
  const params = new URLSearchParams({ realm: ARIBA.realm, ...extra });
  const r = await fetch(`${ARIBA.baseUrl}${apiPath}?${params}`, {
    headers: { "Authorization": `Bearer ${token}`, "apiKey": ARIBA.apiKey, "Accept": "application/json" },
  });
  if (!r.ok) throw new Error(`Ariba API error (${r.status}): ${await r.text()}`);
  return r.json();
}

// ── Parse POST body ───────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(undefined); }
    });
  });
}

// ── Build MCP server with all tool handlers ───────────────────────────────
function buildServer() {
  const server = new Server(
    { name: "ariba-realm-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_requisitions",
        description: "Fetch purchase requisitions from the SAP Ariba realm.",
        inputSchema: {
          type: "object",
          properties: {
            status:      { type: "string", description: "Approved | Denied | Composing | Submitted | Ordering" },
            requesterId: { type: "string", description: "Ariba user ID of the requester" },
            top:         { type: "number", description: "Max records (default 20)" },
          },
        },
      },
      {
        name: "get_purchase_orders",
        description: "Fetch purchase orders from the SAP Ariba realm.",
        inputSchema: {
          type: "object",
          properties: {
            status:       { type: "string", description: "Ordered | Received | Cancelled | Invoiced" },
            supplierName: { type: "string", description: "Partial supplier name" },
            top:          { type: "number", description: "Max records (default 20)" },
          },
        },
      },
      {
        name: "get_invoices",
        description: "Fetch invoices from the SAP Ariba realm.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", description: "Reconciled | Rejected | Paying | Paid | Approving" },
            top:    { type: "number", description: "Max records (default 20)" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    const top = Math.min(Number(a?.top || 20), 100).toString();
    const f = (...parts) => parts.filter(Boolean).join(" and ") || undefined;
    try {
      if (name === "get_requisitions") {
        const $filter = f(
          a?.status      ? `Status eq '${a.status}'` : null,
          a?.requesterId ? `RequesterUserId eq '${a.requesterId}'` : null
        );
        const data = await aribaGet(
          "/api/procurement-reports/v2/prod/views/RequisitionLineItemFact",
          { $top: top, ...($filter ? { $filter } : {}) }
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      if (name === "get_purchase_orders") {
        const $filter = f(
          a?.status       ? `Status eq '${a.status}'` : null,
          a?.supplierName ? `contains(SupplierName,'${a.supplierName}')` : null
        );
        const data = await aribaGet(
          "/api/procurement-reports/v2/prod/views/PurchaseOrderLineItemFact",
          { $top: top, ...($filter ? { $filter } : {}) }
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      if (name === "get_invoices") {
        const $filter = f(a?.status ? `ReconciliationStatus eq '${a.status}'` : null);
        const data = await aribaGet(
          "/api/invoice-reconciliation-reports/v1/prod/views/InvoiceLineItemFact",
          { $top: top, ...($filter ? { $filter } : {}) }
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ── HTTP server — stateless: fresh transport per request ──────────────────
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer();

httpServer.on("request", async (req, res) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);

  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (code, ...args) => {
    console.log(`[RESPONSE] ${req.method} ${req.url} → ${code}`);
    return origWriteHead(code, ...args);
  };

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, Mcp-Session-Id, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health")    { res.writeHead(200); res.end("OK"); return; }

  if (req.url === "/mcp") {
    const body = req.method === "POST" ? await parseBody(req) : undefined;

    // Fresh transport + server for every request — no session state to lose
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server    = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

httpServer.listen(PORT, () => console.log(`[Ariba MCP] Listening on :${PORT}/mcp`));
