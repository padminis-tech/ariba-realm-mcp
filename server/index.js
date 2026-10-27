/**
 * Ariba Realm MCP Server — Phase 1 Read Tools
 * Tools: get_requisitions | get_purchase_orders | get_invoices
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as http from "http";

// ── Ariba config (from Kyma secret / local .env) ───────────────────────────
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

// ── Token cache ────────────────────────────────────────────────────────────
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
  console.log("[Ariba MCP] Token refreshed");
  return _token;
}

// ── Ariba GET helper ───────────────────────────────────────────────────────
async function aribaGet(apiPath, extra = {}) {
  if (!ready) throw new Error("Ariba credentials not configured. Update ariba-credentials Kyma secret.");
  const token  = await getToken();
  const params = new URLSearchParams({ realm: ARIBA.realm, ...extra });
  const r = await fetch(`${ARIBA.baseUrl}${apiPath}?${params}`, {
    headers: { "Authorization": `Bearer ${token}`, "apiKey": ARIBA.apiKey, "Accept": "application/json" },
  });
  if (!r.ok) throw new Error(`Ariba API error (${r.status}) on ${apiPath}: ${await r.text()}`);
  return r.json();
}

// ── MCP Server ────────────────────────────────────────────────────────────
const server = new Server(
  { name: "ariba-realm-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_requisitions",
      description: "Fetch purchase requisitions from the SAP Ariba realm. Filter by status or requester.",
      inputSchema: {
        type: "object",
        properties: {
          status:      { type: "string", description: "Approved | Denied | Composing | Submitted | Ordering" },
          requesterId: { type: "string", description: "Ariba user ID of the requester" },
          top:         { type: "number", description: "Max records (default 20, max 100)" },
        },
      },
    },
    {
      name: "get_purchase_orders",
      description: "Fetch purchase orders from the SAP Ariba realm. Filter by status or supplier.",
      inputSchema: {
        type: "object",
        properties: {
          status:       { type: "string", description: "Ordered | Received | Cancelled | Invoiced" },
          supplierName: { type: "string", description: "Partial supplier name (e.g. Accenture)" },
          top:          { type: "number", description: "Max records (default 20, max 100)" },
        },
      },
    },
    {
      name: "get_invoices",
      description: "Fetch invoices from the SAP Ariba realm. Filter by reconciliation status.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Reconciled | Rejected | Paying | Paid | Approving" },
          top:    { type: "number", description: "Max records (default 20, max 100)" },
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
      // ⚠ Verify endpoint path in developer.ariba.com → Try Out, for your approved API version
      const data = await aribaGet("/api/procurement-reports/v2/prod/views/RequisitionLineItemFact",
        { $top: top, ...($filter ? { $filter } : {}) });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    if (name === "get_purchase_orders") {
      const $filter = f(
        a?.status       ? `Status eq '${a.status}'` : null,
        a?.supplierName ? `contains(SupplierName,'${a.supplierName}')` : null
      );
      const data = await aribaGet("/api/procurement-reports/v2/prod/views/PurchaseOrderLineItemFact",
        { $top: top, ...($filter ? { $filter } : {}) });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    if (name === "get_invoices") {
      const $filter = f(a?.status ? `ReconciliationStatus eq '${a.status}'` : null);
      const data = await aribaGet("/api/invoice-reconciliation-reports/v1/prod/views/InvoiceLineItemFact",
        { $top: top, ...($filter ? { $filter } : {}) });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// ── HTTP server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer();
const transport  = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

httpServer.on("request", (req, res) => {

  // Log every incoming request so we can see what JWD sends
  console.log(`[REQUEST] ${req.method} ${req.url}`);

  // CORS headers for JWD (Electron renderer)
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, Accept");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if      (req.url === "/mcp")    transport.handleRequest(req, res);
  else if (req.url === "/health") { res.writeHead(200); res.end("OK"); }
  else {
    console.log(`[404] ${req.method} ${req.url} — not handled`);
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.connect(transport);
httpServer.listen(PORT, () =>
  console.log(`[Ariba MCP] Listening on :${PORT}/mcp`)
);

});
server.connect(transport);
httpServer.listen(PORT, () => console.log(`[Ariba MCP] Listening on :${PORT}/mcp`));
