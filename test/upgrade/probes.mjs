// Feature probes, run against one replicator over HTTP.
//
//   node probes.mjs <group> <base url> <new|old>
//
// With "new", each check must pass. With "old" (a 3.8.1 replicator, for
// comparison) the outcome is printed and nothing fails, so one run of the
// harness shows what changed.
import { check as strictCheck, done, read, records, request, save, token, readFeeds } from "./lib.mjs";

const [group, base, mode = "new"] = process.argv.slice(2);
const check = mode === "new"
  ? strictCheck
  : (name, ok, detail = "") => console.log(`INFO  ${name}: ${ok ? "as 4.0 expects" : "differs from 4.0"}${detail ? `  (${detail})` : ""}`);
const short = r => `${r.status} ${(r.text || "").replace(/\s+/g, " ").slice(0, 140)}`;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const groups = {
  // F1, F2, F3, F17, F18: specification shapes, on an open replicator.
  async shapes() {
    const disconnected = await read(base, `
let a: H.Company = { name: "a" }
let b: H.Person = { name: "b" }
(a: H.Company, b: H.Person) {
    o: H.Office [ o->company: H.Company = a ]
    p: H.Project [ p->creator: H.Person = b ]
} => { o = o p = p }`);
    check("F1 a disconnected /read is refused with 400 naming both subgraphs",
      disconnected.status === 400 && /disconnected/i.test(disconnected.text), short(disconnected));

    const joined = await read(base, `
let a: H.Company = { name: "a" }
(a: H.Company) {
    o: H.Office [ o->company: H.Company = a ]
} => o`);
    check("F1 control: the same spec joined is served", joined.status === 200, short(joined));

    const unusedGiven = await read(base, `
let a: H.Company = { name: "a" }
let b: H.Person = { name: "b" }
(a: H.Company, b: H.Person) {
    o: H.Office [ o->company: H.Company = a ]
} => o`);
    check("F2 a given that no match uses is served", unusedGiven.status === 200, short(unusedGiven));

    const products = {
      "J!": `
let p1: H.R = { n: 1 }
let p2: H.A = { n: 2 }
(p1: H.R, p2: H.A) {
    u: H.A [ u->a: H.A = p2 ]
    c: H.A [ c->r: H.R = p1 !E { e: H.E [ e->c: H.A = c ] } ]
    x: H.B [ x->c: H.A = c x->u: H.A = u ]
} => x`,
      "B": `
let p1: H.R = { n: 1 }
let p2: H.A = { n: 2 }
(p1: H.R, p2: H.A) {
    u: H.U [ u->r: H.R = p1 ]
    x: H.X [ x->a: H.A = p2 !E { e: H.E [ e->u: H.U = u e->x: H.X = x ] } ]
} => x`
    };
    for (const [shape, text] of Object.entries(products)) {
      const r = await request(`${base}/feeds`, { contentType: "text/plain", body: text });
      check(`F3 a ${shape} product feed is refused with 400`, r.status === 400, short(r));
    }

    // F17: a specification with no matches returns its given.
    const company = { type: "H.Company", name: `given-only-${run}` };
    await save(base, records(company));
    const givenOnly = await read(base, `
let c: H.Company = { name: "given-only-${run}" }
(c: H.Company) { } => c.name`);
    check("F17 a given-only /read returns the given",
      givenOnly.status === 200 && givenOnly.text.includes(`given-only-${run}`), short(givenOnly));

    // F18: an identity between two bound labels, `o = office`. Before
    // jinaga-server #230 the office of another company was returned too.
    const mine = { type: "H.Company", name: `mine-${run}` };
    const theirs = { type: "H.Company", name: `theirs-${run}` };
    await save(base, [
      ...records({ type: "H.Office", company: mine, name: `own-${run}` }),
      ...records({ type: "H.Office", company: theirs, name: `other-${run}` })
    ]);
    const officeOf = (owner, name) => read(base, `
let owner: H.Company = { name: "${owner}-${run}" }
let office: H.Office = { company: owner, name: "${name}-${run}" }
let company: H.Company = { name: "mine-${run}" }
(office: H.Office, company: H.Company [
    E { o: H.Office [ o->company: H.Company = company o = office ] }
]) { } => office.name`);
    const other = await officeOf("theirs", "other");
    check("F18 an identity condition returns no office of another company",
      other.status === 200 && Array.isArray(other.json) && other.json.length === 0, short(other));
    const own = await officeOf("mine", "own");
    check("F18 control: it returns the office of the given company",
      own.status === 200 && own.text.includes(`own-${run}`), short(own));
  },

  // F13: the graph save line limit, at the default of 1 MiB.
  async lineLimit() {
    const limit = Number(process.env.EXPECT_LIMIT || 1024 * 1024);
    const fact = bytes => ({ type: "H.Blob", run, body: "x".repeat(bytes) });
    const under = await save(base, records(fact(limit - 4096)), { format: "graph" });
    check(`F13 a fact just under ${limit} bytes is saved`, under.status === 201, short(under));
    const over = await save(base, records(fact(limit + 1)), { format: "graph" });
    check(`F13 a fact over ${limit} bytes is refused with 413`,
      over.status === 413 && /exceeded the maximum/.test(over.text), short(over));
  },

  // F5: a fact authorized by another fact in the same request.
  async batch() {
    const login = async sub => {
      const auth = token(sub);
      const r = await request(`${base}/login`, { method: "GET", auth });
      if (r.status !== 200) throw new Error(`login ${sub}: ${short(r)}`);
      return { auth, user: { type: "Jinaga.User", publicKey: r.json.userFact.fields.publicKey } };
    };
    const organizer = await login(`organizer-${run}`);
    const attendee = await login(`attendee-${run}`);
    const tenant = { type: "H.Tenant", creator: organizer.user, identifier: run };
    const t = await save(base, records(tenant), { auth: organizer.auth });
    if (t.status !== 201) throw new Error(`tenant: ${short(t)}`);

    const attendance = { type: "H.Attendee", user: attendee.user, tenant };
    const answer = { type: "H.Answer", tenant, author: attendee.user, value: "yes" };
    const both = await save(base, [...records(attendance), ...records(answer)].filter(unique), { auth: attendee.auth });
    check("F5 an Answer and the Attendee that authorizes it are accepted in one request", both.status === 201, short(both));

    const tenant2 = { type: "H.Tenant", creator: organizer.user, identifier: `${run}-2` };
    await save(base, records(tenant2), { auth: organizer.auth });
    const alone = await save(base, records({ type: "H.Answer", tenant: tenant2, author: attendee.user, value: "no" }), { auth: attendee.auth });
    check("F5 control: an Answer nothing authorizes is refused with 403", alone.status === 403, short(alone));
  },

  // F6, F7: share rules that 3.8.1 could not build.
  async feeds() {
    const calendar = { type: "H.Calendar", name: `cal-${run}` };
    const kept = { type: "H.Event", calendar, name: "kept" };
    const pendingDelete = { type: "H.Event", calendar, name: "delete pending" };
    const approvedDelete = { type: "H.Event", calendar, name: "delete approved" };
    const d1 = { type: "H.Delete", event: pendingDelete };
    const d2 = { type: "H.Delete", event: approvedDelete };
    const approval = { type: "H.Approval", delete: d2 };
    await save(base, [kept, pendingDelete, d1, approval].flatMap(records).filter(unique));
    const spec = `
let c: H.Calendar = { name: "cal-${run}" }
(c: H.Calendar) {
    e: H.Event [
        e->calendar: H.Calendar = c
        !E { d: H.Delete [ d->event: H.Event = e E { a: H.Approval [ a->delete: H.Delete = d ] } ] }
    ]
} => e`;
    const events = await read(base, spec);
    const names = Array.isArray(events.json) ? events.json.map(e => e.name).sort() : [];
    check("F6 events whose delete is approved drop out; the rest are shared",
      events.status === 200 && JSON.stringify(names) === JSON.stringify(["delete pending", "kept"]), `${events.status} ${JSON.stringify(names)}`);
    const feeds = await readFeeds(base, spec);
    check("F6 the feed of that share rule is served", feeds.status === 200, feeds.text || "");

    const restaurant = { type: "H.Restaurant", name: `r-${run}` };
    const server = { type: "H.Server", restaurant, name: "sam" };
    const rate = { type: "H.Rate", server, value: 20 };
    await save(base, records(rate));
    const rates = await read(base, `
let r: H.Restaurant = { name: "r-${run}" }
(r: H.Restaurant) {
    s: H.Server [
        s->restaurant: H.Restaurant = r
        !E { st: H.Terminated [ st->server: H.Server = s !E { sr: H.Rehired [ sr->terminated: H.Terminated = st ] } ] }
    ]
} => { rates = { sr: H.Rate [ sr->server: H.Server = s ] } => sr.value }`);
    check("F7 a share rule that repeats a label serves its rates",
      rates.status === 200 && rates.text.includes("20"), short(rates));
  }
};

function unique(r, i, all) {
  return all.findIndex(o => o.type === r.type && o.hash === r.hash) === i;
}

try {
  await groups[group]();
}
catch (error) {
  strictCheck(`${group} ran`, false, error.message);
}
done();
