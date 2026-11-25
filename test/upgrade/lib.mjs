// Helpers for the upgrade harness: raw HTTP against a replicator, so each test
// controls the exact request a client would send.
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dehydrateFact, serializeGraph } = require("jinaga");

export const secret = "upgrade-harness-shared-secret-not-for-production";

// An HS256 token the fixtures' harness.provider accepts.
export function token(sub, name = sub) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT", kid: "harness" });
  const body = b64({ iss: "upgrade-harness", aud: "replicator", sub, name, iat: now, exp: now + 3600 });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function headers(auth, contentType) {
  const h = {};
  if (contentType) h["Content-Type"] = contentType;
  if (auth) h["Authorization"] = `Bearer ${auth}`;
  return h;
}

export async function request(url, { method = "POST", body, contentType, auth, accept } = {}) {
  const h = headers(auth, contentType);
  if (accept) h["Accept"] = accept;
  const res = await fetch(url, { method, headers: h, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, type: res.headers.get("content-type"), text, json };
}

// The fact records of an object graph, predecessors first.
export function records(fact) {
  return dehydrateFact(fact);
}

// Save records as one request. order "reverse" puts successors first, which
// the JSON format permits and the graph format cannot express.
export async function save(base, recs, { auth, format = "json", order = "forward" } = {}) {
  const list = order === "reverse" ? [...recs].reverse() : recs;
  if (format === "graph") {
    return request(`${base}/save`, {
      contentType: "application/x-jinaga-graph-v1",
      body: serializeGraph(list.map(fact => ({ fact, signatures: [] }))),
      auth
    });
  }
  return request(`${base}/save`, {
    contentType: "application/json",
    body: JSON.stringify({ facts: list }),
    auth
  });
}

export const read = (base, text, auth) =>
  request(`${base}/read`, { contentType: "text/plain", body: text, auth });

export const write = (base, text, auth) =>
  request(`${base}/write`, { contentType: "text/plain", body: text, auth });

// Every reference a feed yields, paging from the start (or from a bookmark).
export async function readFeeds(base, text, auth, bookmark = "") {
  const feeds = await request(`${base}/feeds`, { contentType: "text/plain", body: text, auth });
  if (feeds.status !== 200) return { status: feeds.status, text: feeds.text };
  const result = {};
  for (const hash of feeds.json.feeds) {
    let b = bookmark;
    const refs = [];
    for (let page = 0; page < 10000; page++) {
      const r = await request(`${base}/feeds/${hash}?b=${encodeURIComponent(b)}`, { method: "GET", auth });
      if (r.status !== 200) return { status: r.status, text: r.text };
      for (const tuple of r.json.references) refs.push(tuple);
      if (r.json.bookmark === b || r.json.references.length === 0) break;
      b = r.json.bookmark;
    }
    result[hash] = { references: refs, bookmark: b };
  }
  return { status: 200, feeds: result, decisions: feeds.json.decisions };
}

export async function waitReady(base, timeoutMs = 120000) {
  const root = base.replace(/\/jinaga$/, "");
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await request(`${root}/ready`, { method: "GET" });
      if (last.status === 200) return last;
      if (last.json?.reason === "initialization failed") return last;
    } catch { }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Not ready after ${timeoutMs} ms: ${last?.text}`);
}

let failures = 0;
export function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
export function done() {
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
}
