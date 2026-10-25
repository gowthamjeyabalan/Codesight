'use strict';
// Problems Codesight points at: complex code, code nothing uses, exceptions nothing catches, and what a change reaches.

// ── complexity ──
// Cyclomatic complexity bands, calm to hot (Grapht categorical colours).
CG.CX_BANDS = [
  { max: 5, color: '#59a14f', label: '1–5' },
  { max: 10, color: '#edc948', label: '6–10' },
  { max: 20, color: '#f28e2b', label: '11–20' },
  { max: Infinity, color: '#e15759', label: '21+' },
];
CG.cxColor = (cx) => CG.CX_BANDS.find((b) => cx <= b.max).color;

/** Per file (lower-case path): the most complex method, the sum, and how many methods have code. */
CG.fileComplexity = function (code) {
  const map = new Map();
  for (const x of code.members) {
    if (!x.cx) continue;
    const key = x.file.toLowerCase();
    const e = map.get(key) || { max: 0, total: 0, methods: 0, worst: null };
    e.total += x.cx;
    e.methods++;
    if (x.cx > e.max) { e.max = x.cx; e.worst = x; }
    map.set(key, e);
  }
  return map;
};

/** The most complex methods and properties among `members`, most complex first. */
CG.hotspots = (members, n = 10) => members.filter((x) => x.cx > 1).sort((p, q) => q.cx - p.cx || (q.nd || 0) - (p.nd || 0)).slice(0, n);

CG.lines = (x) => (x.le != null ? x.le - x.l + 1 : 0);

// ── unused code ──
/**
 * Marks members and types with no use found in the solution's C#. Left out on purpose: constructors, enum values,
 * operators, entry points, and members that override or implement something (they are called through it).
 * Reflection, XAML bindings and serializers can still use what is marked, so the views say "no use found".
 */
CG.markUnused = function (code) {
  const used = (x) => x.in.size > 0 || x.refIn.size > 0;
  for (const x of code.members) {
    x.unused = false;
    if (x.k === 'ctor' || x.k === 'value' || x.k === 'operator' || x.ov || x.ep || x.n === 'Main') continue;
    if (used(x)) continue;
    // an interface or abstract member is used when one of its implementations is
    if (x.implementedBy.some(used)) continue;
    x.unused = true;
  }
  for (const t of code.types) {
    t.unused = false;
    if (t.xaml || t.fw || t.derived.length || t.implementors.length || t.usedBy.length) continue;
    if ([...t.namedBy].some((m) => m.type !== t)) continue;
    // used through an interface or base it implements (often created by dependency injection, never with new)
    if (t.m.some((x) => x.implements.some((im) => im.in.size > 0 || im.refIn.size > 0))) continue;
    const fromOutside = t.m.some((x) => x.ep || [...x.in.keys(), ...x.refIn.keys()].some((c) => c.type !== t));
    if (fromOutside) continue;
    t.unused = true;
  }
  code.unusedMembers = code.members.filter((x) => x.unused);
  code.unusedTypes = code.types.filter((t) => t.unused);
};

// ── exceptions ──
/** The catch a throw step ends in: walks out through try blocks and calls until a catch takes its type. */
CG.catchOf = function (t) {
  let chain = t.tt || [];
  let child = t;
  for (let p = t.parent; p; child = p, p = p.parent) {
    if (p.k !== 'try') continue;
    const at = p.b.findIndex((b) => b.s.includes(child));
    // a bare throw; in a catch throws on what that catch caught
    if (t.rt && !chain.length && at > 0 && p.b[at].ct) {
      chain = [p.b[at].ct];
      continue;
    }
    if (at !== 0) continue; // thrown from a catch or a finally: it goes on outwards
    for (const b of p.b.slice(1)) {
      if (!b.ct) continue;
      const unknown = !chain.length;
      if (unknown || chain.includes(b.ct) || b.ct === 'Exception')
        return { step: t, chain, by: p, branch: b, maybe: b.cf || (unknown && b.ct !== 'Exception') };
    }
  }
  return { step: t, chain, by: null, branch: null, maybe: false };
};

/** Every throw in a flow with where it is caught, and the try blocks that catch something. */
CG.exceptionMap = function (data) {
  const throws = [], catches = new Map();
  const visit = (s) => {
    if (s.k === 'throw') {
      const c = CG.catchOf(s);
      throws.push(c);
      if (c.by) catches.set(c.by, (catches.get(c.by) || 0) + 1);
    }
    (s.s || []).forEach(visit);
    (s.b || []).forEach((b) => b.s.forEach(visit));
  };
  visit(data.root);
  return { throws, catches, uncaught: throws.filter((c) => !c.by) };
};

// ── where is this used ──
/**
 * Who uses `target`, in two groups drawn left and right of it: for a property, field or event, what writes it and
 * what reads it; for a method, what calls it (also through an interface it implements) and what passes it on as a
 * delegate; for a type, what creates or names it and which fields and properties hold one.
 */
CG.usesOf = function (code, target) {
  const reads = (x, m) => (x.refIn.get(m) || 0) - (x.writeIn.get(m) || 0);
  if (target.ck === 'member' && (target.k === 'prop' || target.k === 'field' || target.k === 'event')) {
    return {
      target, kind: 'data',
      left: [...target.writeIn.keys()], right: [...target.refIn.keys()].filter((m) => reads(target, m) > 0),
      leftTitle: 'Writes it', rightTitle: 'Reads it',
      count: (m, side) => (side < 0 ? target.writeIn.get(m) : reads(target, m)),
    };
  }
  if (target.ck === 'member') {
    const callers = new Map(target.in);
    for (const im of target.implements) for (const [c, n] of im.in) callers.set(c, (callers.get(c) || 0) + n);
    return {
      target, kind: 'method',
      left: [...callers.keys()], right: [...target.refIn.keys()],
      leftTitle: 'Calls it', rightTitle: 'Passes it on',
      count: (m, side) => (side < 0 ? callers.get(m) : target.refIn.get(m)),
    };
  }
  const makers = new Set(target.namedBy);
  for (const x of target.m) if (x.k === 'ctor') for (const c of x.in.keys()) makers.add(c);
  const plain = target.n.replace(/<.*/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const holds = new RegExp(`(^|[^\\w])${plain}([^\\w]|$)`);
  return {
    target, kind: 'type',
    left: [...makers].filter((m) => m.type !== target),
    right: code.members.filter((x) => (x.k === 'prop' || x.k === 'field') && x.type !== target && x.r && holds.test(x.r)),
    leftTitle: 'Creates or names it', rightTitle: 'Holds one',
    count: () => null,
  };
};

// ── impact ──
/**
 * What a change to `target` (a member, or every member of a type) can reach: everything that calls it, uses it,
 * or calls what it implements, all the way up to where flows start. Returns the distance of each member reached.
 */
CG.impactOf = function (target) {
  const start = target.ck === 'type' ? target.m : [target];
  const reached = new Map();
  const queue = [];
  for (const m of start) {
    reached.set(m, 0);
    queue.push(m);
  }
  while (queue.length) {
    const m = queue.shift();
    const d = reached.get(m);
    const up = new Set([...m.in.keys(), ...m.refIn.keys()]);
    for (const im of m.implements) {
      for (const c of im.in.keys()) up.add(c);
      for (const c of im.refIn.keys()) up.add(c);
    }
    for (const c of up)
      if (!reached.has(c)) {
        reached.set(c, d + 1);
        queue.push(c);
      }
  }
  const affected = [...reached.keys()].filter((m) => reached.get(m) > 0);
  const entries = [...reached.keys()].filter((m) => m.ep);
  const types = new Set(affected.map((m) => m.type));
  const dependents = target.ck === 'type' ? [...new Set([...target.derived, ...target.implementors, ...target.usedBy, ...[...target.namedBy].map((m) => m.type)])].filter((t) => t !== target) : [];
  return { target, start, reached, affected, entries, types, dependents };
};
