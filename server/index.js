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
const ENV   = ARIBA.realm.endsWith("-T") ? "sandbox" : "prod";

console.log(ready
  ? `[Ariba MCP] Ready — realm: ${ARIBA.realm} | env: ${ENV}`
  : "[Ariba MCP] WARNING: credentials not set"
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
async function aribaGet(apiPath, queryParams = {}) {
  if (!ready) throw new Error("Ariba credentials not configured.");
  const token  = await getToken();
  const params = new URLSearchParams({ realm: ARIBA.realm, ...queryParams });
  const url    = `${ARIBA.baseUrl}${apiPath}?${params}`;
  console.log(`[Ariba] GET ${url}`);
  const r = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}`, "apiKey": ARIBA.apiKey, "Accept": "application/json" },
  });
  if (!r.ok) throw new Error(`Ariba API error (${r.status}): ${await r.text()}`);
  return r.json();
}

// ── Default date range (last 31 days) ─────────────────────────────────────
function defaultDateRange() {
  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    from: fmt(new Date(Date.now() - 31 * 86_400_000)),
    to:   fmt(new Date()),
  };
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

// ── Build MCP server ──────────────────────────────────────────────────────
function buildServer() {
  const server = new Server(
    { name: "ariba-realm-mcp", version: "1.1.0" },
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
            status:          { type: "string", description: "Approved | Denied | Composing | Submitted | Ordering" },
            requesterId:     { type: "string", description: "Ariba user ID of the requester" },
            top:             { type: "number", description: "Max records (default 20)" },
            createdDateFrom: { type: "string", description: "ISO 8601 start e.g. 2017-01-01T00:00:00Z (default: 31 days ago)" },
            createdDateTo:   { type: "string", description: "ISO 8601 end e.g. 2017-12-31T23:59:59Z (default: now)" },
          },
        },
      },
      {
        name: "get_purchase_orders",
        description: "Fetch purchase orders from the SAP Ariba realm.",
        inputSchema: {
          type: "object",
          properties: {
            status:          { type: "string", description: "Ordered | Received | Cancelled | Invoiced" },
            supplierName:    { type: "string", description: "Partial supplier name" },
            top:             { type: "number", description: "Max records (default 20)" },
            createdDateFrom: { type: "string", description: "ISO 8601 start e.g. 2017-01-01T00:00:00Z (default: 31 days ago)" },
            createdDateTo:   { type: "string", description: "ISO 8601 end e.g. 2017-12-31T23:59:59Z (default: now)" },
          },
        },
      },
      {
        name: "get_invoices",
        description: "Fetch invoices from the SAP Ariba realm.",
        inputSchema: {
          type: "object",
          properties: {
            status:          { type: "string", description: "Reconciled | Rejected | Paying | Paid | Approving" },
            top:             { type: "number", description: "Max records (default 20)" },
            createdDateFrom: { type: "string", description: "ISO 8601 start e.g. 2017-01-01T00:00:00Z (default: 31 days ago)" },
            createdDateTo:   { type: "string", description: "ISO 8601 end e.g. 2017-12-31T23:59:59Z (default: now)" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    const top   = Math.min(Number(a?.top || 20), 100).toString();
    const range = defaultDateRange();
    const dateFrom = a?.createdDateFrom ?? range.from;
    const dateTo   = a?.createdDateTo   ?? range.to;

    try {
      // ── get_requisitions ──────────────────────────────────────────────
      if (name === "get_requisitions") {
        const filters = { CreateDate: [{ from: dateFrom, to: dateTo }] };
        if (a?.status)      filters.Status      = [a.status];
        if (a?.requesterId) filters.RequesterId = [a.requesterId];
        const data = await aribaGet(
          `/api/procurement-reporting-details/v2/${ENV}/views/RequisitionLineItemFact`,
          { $top: top, filters: JSON.stringify(filters) }
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      // ── get_purchase_orders ───────────────────────────────────────────
      if (name === "get_purchase_orders") {
        const filters = { CreateDate: [{ from: dateFrom, to: dateTo }] };
        if (a?.status)       filters.Status       = [a.status];
        if (a?.supplierName) filters.SupplierName = [a.supplierName];
        const data = await aribaGet(
          `/api/procurement-reporting-details/v2/${ENV}/views/PurchaseOrderLineItemFact`,
          { $top: top, filters: JSON.stringify(filters) }
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      // ── get_invoices ──────────────────────────────────────────────────
      if (name === "get_invoices") {
        const filters = { CreateDate: [{ from: dateFrom, to: dateTo }] };
        if (a?.status) filters.Status = [a.status];
        const data = await aribaGet(
          `/api/procurement-reporting-details/v2/${ENV}/views/InvoiceLineItemFact`,
          { $top: top, filters: JSON.stringify(filters) }
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

  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, Mcp-Session-Id, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health")    { res.writeHead(200); res.end(JSON.stringify({ status: "ok", version: "1.1.0" })); return; }

  if (req.url === "/mcp") {
    const body      = req.method === "POST" ? await parseBody(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server    = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

httpServer.listen(PORT, () => console.log(`[Ariba MCP v1.1.0] Listening on :${PORT}/mcp`));
