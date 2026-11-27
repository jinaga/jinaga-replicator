// Mesh probes: a downstream replicator subscribing to an upstream one.
//   node mesh.mjs <new|old>
import { execFileSync } from "node:child_process";
import { check as strictCheck, done, read, records, save } from "./lib.mjs";

const mode = process.argv[2] || "new";
const check = mode === "new"
  ? strictCheck
  : (name, ok, detail = "") => console.log(`INFO  ${name}: ${ok ? "as 4.0 expects" : "differs from 4.0"}${detail ? `  (${detail})` : ""}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const count = (container, type) => Number(execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "replicator", "-Atc",
  `select count(*) from fact f join fact_type t on t.fact_type_id = f.fact_type_id where t.name = '${type}'`]).toString().trim());

const up = "http://localhost:18092/jinaga", down = "http://localhost:18094/jinaga", pusher = "http://localhost:18093/jinaga";

// F8: an event whose delete was both restored and undone is still shared.
const calendar = { type: "H.Calendar", name: "team" };
const restored = { type: "H.Event", calendar, name: "restored and undone" };
const deleted = { type: "H.Event", calendar, name: "deleted" };
const untouched = { type: "H.Event", calendar, name: "untouched" };
const d1 = { type: "H.Delete", event: restored };
const d2 = { type: "H.Delete", event: deleted };
const facts = [untouched, d2, { type: "H.Restore", delete: d1 }, { type: "H.Undo", delete: d1 }];
await save(up, facts.flatMap(records).filter((r, i, a) => a.findIndex(o => o.hash === r.hash && o.type === r.type) === i), { format: "graph" });
const spec = `let c: H.Calendar = { name: "team" }
(c: H.Calendar) {
    e: H.Event [
        e->calendar: H.Calendar = c
        !E { d: H.Delete [ d->event: H.Event = e !E { r: H.Restore [ r->delete: H.Delete = d ] } !E { u: H.Undo [ u->delete: H.Delete = d ] } ] }
    ]
} => e.name`;
const expected = JSON.stringify(["restored and undone", "untouched"]);
let names = "[]";
for (let i = 0; i < 60 && names !== expected; i++) {
  await sleep(500);
  const r = await read(down, spec);
  names = JSON.stringify(Array.isArray(r.json) ? r.json.sort() : r.text);
}
const upNames = JSON.stringify(((await read(up, spec)).json || []).sort());
check("F8 the downstream replica receives an event restored through two cancellers", names === expected, `downstream ${names}, upstream ${upNames}`);

// F19: a subscription whose condition joins only its given. jr-given holds
// the `given-only` fixture, which subscribes to jr-up for the items of the
// root named "given-only" while that root has no lock.
const given = "http://localhost:18095/jinaga";
if (process.env.GIVEN_ONLY !== "ready") {
  check("F19 the given-only fixture's policy and subscription load", false, "jr-given failed initialization");
}
else {
  const root = { type: "H.Root", name: "given-only" };
  const itemSpec = `let r: H.Root = { name: "given-only" }
(r: H.Root) {
    b: H.Item [
        b->root: H.Root = r
        !E { a: H.Lock [ a->root: H.Root = r ] }
    ]
} => b.name`;
  const poll = async want => {
    let got;
    for (let i = 0; i < 60; i++) {
      const r = await read(given, itemSpec);
      got = JSON.stringify(Array.isArray(r.json) ? r.json : r.text);
      if (got === want) break;
      await sleep(500);
    }
    return got;
  };
  await save(up, records({ type: "H.Item", root, name: "item" }), { format: "graph" });
  const before = await poll(JSON.stringify(["item"]));
  check("F19 the subscription pulls the item while the root has no lock", before === JSON.stringify(["item"]), before);
  await save(up, records({ type: "H.Lock", root }), { format: "graph" });
  const after = await poll("[]");
  check("F19 it pulls the lock, and the item drops out", after === "[]" && count("jr-given", "H.Lock") === 1,
    `${after}, ${count("jr-given", "H.Lock")} lock(s) downstream`);
}

// Push: a fact saved to a replicator with an upstream. jinaga-server's
// PostgresQueue does not yet store anything, so nothing is pushed.
await save(pusher, records({ type: "H.Foo", n: Date.now() }), { format: "graph" });
await sleep(5000);
console.log(`INFO  push: a fact saved to a replicator reached its upstream: ${count("jr-picky", "H.Foo") > 0}`);
done();
