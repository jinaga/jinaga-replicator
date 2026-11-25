// A stand-in upstream for F12: it answers POST /feeds with a feed decision
// kind and denial code that no released replicator emits, as a later server
// might, and an empty feed. Each request is logged, so the harness can see
// whether the subscription went on to read the feed.
import { createServer } from "node:http";
const hash = "stubfeed";
createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);
  const json = body => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  req.resume();
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/jinaga/feeds") {
      return json({ feeds: [hash], decisions: [{ feed: hash, decision: "future-kind", code: "new-code", reason: "a decision from a later server" }] });
    }
    if (req.url.startsWith(`/jinaga/feeds/${hash}`)) return json({ references: [], bookmark: "" });
    if (req.url === "/jinaga/load") return json({ facts: [] });
    if (req.method === "OPTIONS") { res.writeHead(204, { Allow: "GET, POST, OPTIONS", "Accept-Post": "application/json" }); return res.end(); }
    json({});
  });
}).listen(8080);
