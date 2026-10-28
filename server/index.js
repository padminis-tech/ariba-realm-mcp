// ─────────────────────────────────────────────────────────────────────────────
// Ariba Realm MCP Server — v1.1.0
//
// What changed from v1.0:
//   • All three tools now accept createdDateFrom / createdDateTo params.
//   • Default: last 31 days (production). Override for test realms.
//     consulting-T has only 2017 data → pass createdDateFrom=2017-01-01T00:00:00Z
//                                                 createdDateTo=2017-12-31T23:59:59Z
//   • get_invoices  → fixed view: Invoice_SAP_createdRange
//   • get_purchase_orders → PurchaseOrder_SAP_createdRange
//   • get_requisitions    → Requisition_SAP_createdRange
// ─────────────────────────────────────────────────────────────────────────────

import { McpServer }                     from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer }                  from "node:http";
import { z }                             from "zod";

// ── Environment ────────────────────────────────────────────────────────────────
const {
  ARIBA_BASE_URL    = "https://openapi.ariba.com",
  ARIBA_TOKEN_URL,
  ARIBA_CLIENT_ID,
  ARIBA_CLIENT_SECRET,
  ARIBA_API_KEY,
  ARIBA_REALM,
  PORT = "3000",
} = process.env;

// ── OAuth 2.0 token cache ──────────────────────────────────────────────────────
let _cachedToken    = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 30_000) return _cachedToken;

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     ARIBA_CLIENT_ID,
    client_secret: ARIBA_CLIENT_SECRET,
  });

  const res = await fetch(ARIBA_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) throw new Error(`Token failed ${res.status}: ${await res.text()}`);

  const data      = await res.json();
  _cachedToken    = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return _cachedToken;
}

// ── Ariba Operational Reporting helper ────────────────────────────────────────
//  GET /api/procurement-reporting/v2/prod/views/{view}?realm=X&filters=k=v;k=v
async function queryView(viewName, filters = {}) {
  const token     = await getAccessToken();
  const filterStr = Object.entries(filters)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(";");

  const qs = new URLSearchParams({ realm: ARIBA_REALM });
  if (filterStr) qs.set("filters", filterStr);

  const url = `${ARIBA_BASE_URL}/api/procurement-reporting/v2/prod/views/${viewName}?${qs}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      apiKey:        ARIBA_API_KEY,
      Accept:        "application/json",
    },
  });

  if (!res.ok)
    throw new Error(`Ariba API ${res.status} (view: ${viewName}): ${await res.text()}`);

  return res.json();
}

// ── Date range helper ─────────────────────────────────────────────────────────
// SAP Ariba sync API restriction: window must be ≤ 31 days.
function defaultDateRange(days = 31) {
  const to   = new Date();
  const from = new Date(Date.now() - days * 86_400_000);
  const fmt  = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { from: fmt(from), to: fmt(to) };
}

// ── Shared date params schema ──────────────────────────────────────────────────
const dateParams = {
  createdDateFrom: z.string().optional().describe(
    "ISO 8601 start e.g. 2017-01-01T00:00:00Z  (default: 31 days ago)"
  ),
  createdDateTo: z.string().optional().describe(
    "ISO 8601 end   e.g. 2017-12-31T23:59:59Z  (default: now, window ≤ 31 days)"
  ),
};

// ── MCP Server ─────────────────────────────────────────────────────────────────
const mcp = new McpServer({ name: "ariba-realm-mcp", version: "1.1.0" });

// ─── get_requisitions ─────────────────────────────────────────────────────────
mcp.tool(
  "get_requisitions",
  "Fetch purchase requisitions from the SAP Ariba realm.",
  {
    requesterId: z.string().optional().describe("Ariba user ID of the requester"),
    status:      z.enum(["Approved","Denied","Composing","Submitted","Ordering"]).optional(),
    top:         z.number().optional().describe("Max records (default 20)"),
    ...dateParams,
  },
  async ({ requesterId, status, createdDateFrom, createdDateTo, top = 20 }) => {
    const range   = defaultDateRange(31);
    const filters = {
      createdDateFrom: createdDateFrom ?? range.from,
      createdDateTo:   createdDateTo   ?? range.to,
    };
    if (status)      filters.status      = status;
    if (requesterId) filters.requesterId = requesterId;

    const data = await queryView("Requisition_SAP_createdRange", filters);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ Records: (data.Records ?? []).slice(0, top) }, null, 2),
      }],
    };
  }
);

// ─── get_purchase_orders ──────────────────────────────────────────────────────
mcp.tool(
  "get_purchase_orders",
  "Fetch purchase orders from the SAP Ariba realm.",
  {
    supplierName: z.string().optional().describe("Partial supplier name"),
    status:       z.enum(["Ordered","Received","Cancelled","Invoiced"]).optional(),
    top:          z.number().optional().describe("Max records (default 20)"),
    ...dateParams,
  },
  async ({ supplierName, status, createdDateFrom, createdDateTo, top = 20 }) => {
    const range   = defaultDateRange(31);
    const filters = {
      createdDateFrom: createdDateFrom ?? range.from,
      createdDateTo:   createdDateTo   ?? range.to,
    };
    if (status)       filters.status       = status;
    if (supplierName) filters.supplierName = supplierName;

    const data = await queryView("PurchaseOrder_SAP_createdRange", filters);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ Records: (data.Records ?? []).slice(0, top) }, null, 2),
      }],
    };
  }
);

// ─── get_invoices ─────────────────────────────────────────────────────────────
mcp.tool(
  "get_invoices",
  "Fetch invoices from the SAP Ariba realm.",
  {
    status: z.enum(["Reconciled","Rejected","Paying","Paid","Approving"]).optional(),
    top:    z.number().optional().describe("Max records (default 20)"),
    ...dateParams,
  },
  async ({ status, createdDateFrom, createdDateTo, top = 20 }) => {
    const range   = defaultDateRange(31);
    const filters = {
      createdDateFrom: createdDateFrom ?? range.from,
      createdDateTo:   createdDateTo   ?? range.to,
    };
    if (status) filters.status = status;

    const data = await queryView("Invoice_SAP_createdRange", filters);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ Records: (data.Records ?? []).slice(0, top) }, null, 2),
      }],
    };
  }
);

// ── HTTP server + health endpoint ─────────────────────────────────────────────
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,   // ← stateless mode — required for Joule
});

await mcp.connect(transport);

const httpServer = createServer(async (req, res) => {

  // CORS — required for Joule Work Desktop
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // Health check
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", realm: ARIBA_REALM, version: "1.1.0" }));
    return;
  }

  // MCP endpoint — only handle /mcp
  if (req.url === "/mcp") {
    try {
      await transport.handleRequest(req, res);   // ← await was missing before
    } catch (err) {
      console.error("[MCP error]", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  res.writeHead(404).end("Not found");
});

httpServer.listen(Number(PORT), () => {
  console.log(`[ariba-realm-mcp v1.1.0] Port ${PORT}`);
  console.log(`Realm : ${ARIBA_REALM}`);
  console.log(`Views : Requisition_SAP_createdRange | PurchaseOrder_SAP_createdRange | Invoice_SAP_createdRange`);
});
