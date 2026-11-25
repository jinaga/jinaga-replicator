// Seed and inspect the data folder that the upgrade phases carry across versions.
//
//   node seed.mjs seed|feeds|bookmarks|resume|reverse <base url> [file]
import { readFileSync } from "node:fs";
import { readFeeds, records, save } from "./lib.mjs";

const [command, base, file] = process.argv.slice(2);
const SITES = 20, POSTS = 10;

const site = i => ({ type: "Blog.Site", domain: `site-${i}.example` });
const post = (i, j) => ({ type: "Blog.Post", site: site(i), createdAt: `2026-01-${String(j + 1).padStart(2, "0")}` });
const title = (i, j, value) => ({ type: "Blog.Post.Title", post: post(i, j), value, prior: [] });
const feedSpec = i => `let s: Blog.Site = { domain: "site-${i}.example" }
(s: Blog.Site) {
    p: Blog.Post [ p->site: Blog.Site = s ]
    t: Blog.Post.Title [ t->post: Blog.Post = p ]
} => t`;
const key = r => `${r.type}:${r.hash}`;

async function seed() {
  for (let i = 0; i < SITES; i++) {
    for (let j = 0; j < POSTS; j++) {
      // Even sites arrive as a client sends them, predecessors first, in the
      // graph format. Odd sites arrive successor first, which the JSON format
      // allows and which 3.8.1 stored in that order, inverting their edges.
      const recs = records(title(i, j, `post ${j} of site ${i}`));
      const r = i % 2 === 0
        ? await save(base, recs, { format: "graph" })
        : await save(base, recs, { order: "reverse" });
      if (r.status !== 201) throw new Error(`save ${i}/${j}: ${r.status} ${r.text}`);
    }
  }
}

// Every feed's tuples, sorted, by hash rather than id.
async function feeds() {
  const lines = [];
  for (let i = 0; i < SITES; i++) {
    const r = await readFeeds(base, feedSpec(i));
    if (r.status !== 200) throw new Error(`feeds ${i}: ${r.status} ${r.text}`);
    for (const feed of Object.values(r.feeds)) {
      for (const reference of feed.references) lines.push(`site-${i} ${key(reference)}`);
    }
  }
  console.log([...new Set(lines)].sort().join("\n"));
}

async function bookmarks() {
  const result = [];
  for (let i = 0; i < SITES; i++) {
    const r = await readFeeds(base, feedSpec(i));
    const [feed] = Object.values(r.feeds);
    result.push({ i, bookmark: feed.bookmark, seen: feed.references.map(key) });
  }
  console.log(JSON.stringify(result));
}

// A reader that took its bookmark before the repair resumes after it. Write a
// new post on every site first: the reader must receive each one, and every
// fact it already had stays accounted for, either before its bookmark or
// delivered again at a moved id.
async function resume() {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  let missing = 0, redelivered = 0;
  for (const { i, bookmark, seen } of saved) {
    const fresh = title(i, POSTS, `after the repair, site ${i}`);
    await save(base, records(fresh), { format: "graph" });
    const r = await readFeeds(base, feedSpec(i), undefined, bookmark);
    const [feed] = Object.values(r.feeds);
    const got = new Set(feed.references.map(key));
    const expected = key(records(fresh)[2]);
    if (!got.has(expected)) missing++;
    redelivered += [...got].filter(k => seen.includes(k)).length;
  }
  console.log(`      (resumed ${saved.length} feeds: ${missing} new facts missing, ${redelivered} facts delivered again at moved ids)`);
  process.exitCode = missing === 0 ? 0 : 1;
}

async function forward() {
  const stamp = Date.now();
  const t = { type: "Blog.Post.Title", post: { type: "Blog.Post", site: { type: "Blog.Site", domain: `forward-${stamp}.example` }, createdAt: String(stamp) }, value: "forward", prior: [] };
  const r = await save(base, records(t), { format: "graph" });
  console.log(`${r.status} ${r.text.slice(0, 160)}`);
}

async function reverse() {
  const stamp = Date.now();
  const s = { type: "Blog.Site", domain: `reverse-${stamp}.example` };
  const p = { type: "Blog.Post", site: s, createdAt: String(stamp) };
  const t = { type: "Blog.Post.Title", post: p, value: "reverse", prior: [] };
  const r = await save(base, records(t), { order: "reverse" });
  console.log(`${r.status} ${r.text.slice(0, 160)}`);
}

await ({ seed, feeds, bookmarks, resume, forward, reverse })[command]();
