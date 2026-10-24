'use strict';
// The C# model from the extension (CodeAnalyzer.cs): types, members and calls, linked both ways.

// Type kind -> colour (Grapht categorical palette); class keeps the C# colour of the map.
CG.KINDS = {
  class: '#b07aa1',
  interface: '#76b7b2',
  struct: '#f28e2b',
  'record struct': '#f28e2b',
  record: '#59a14f',
  enum: '#edc948',
  delegate: '#ff9da7',
};
CG.kindColor = (k) => CG.KINDS[k] || '#80848c';
CG.isMethod = (x) => x.k === 'method' || x.k === 'ctor' || x.k === 'operator';
// UML visibility marks
CG.ACCESS = { public: '+', private: '−', protected: '#', internal: '~', 'protected internal': '#', 'private protected': '−' };

CG.buildCode = function (m) {
  const byId = new Map(), types = [], members = [];
  for (const t of m.types) {
    t.ck = 'type';
    t.i = t.i || [];
    t.u = t.u || [];
    t.full = t.ns ? `${t.ns}.${t.n}` : t.n;
    t.derived = [];
    t.implementors = [];
    t.usedBy = [];
    byId.set(t.id, t);
    types.push(t);
    for (const x of t.m) {
      x.ck = 'member';
      x.type = t;
      x.file = x.f || t.f;
      x.out = new Map(); // callee -> call sites
      x.in = new Map(); // caller -> call sites
      x.label = x.k === 'ctor' ? `new ${t.n}` : `${t.n}.${x.n}`;
      byId.set(x.id, x);
      members.push(x);
    }
  }
  for (const t of types) {
    const b = t.b != null && byId.get(t.b);
    if (b) b.derived.push(t);
    for (const i of t.i) byId.get(i)?.implementors.push(t);
    for (const u of t.u) byId.get(u)?.usedBy.push(t);
  }
  let calls = 0;
  for (let k = 0; k + 2 < m.calls.length; k += 3) {
    const a = byId.get(m.calls[k]), b = byId.get(m.calls[k + 1]);
    if (!a || !b) continue;
    a.out.set(b, m.calls[k + 2]);
    b.in.set(a, m.calls[k + 2]);
    calls++;
  }

  const nsMap = new Map();
  for (const t of types) {
    let ns = nsMap.get(t.ns);
    if (!ns) nsMap.set(t.ns, (ns = { ck: 'ns', key: t.ns, name: t.ns || '(global namespace)', types: [] }));
    ns.types.push(t);
  }
  const byName = (p, q) => p.n.localeCompare(q.n);
  const namespaces = [...nsMap.values()].sort((p, q) => p.name.localeCompare(q.name));
  namespaces.forEach((ns, i) => { ns.index = i; ns.types.sort(byName); });

  const byFile = new Map();
  for (const t of types) {
    const f = t.f.toLowerCase();
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(t);
  }
  // types by their plain name, to find "ConversionResult" in a type text like "List<ConversionResult>"
  const byShort = new Map();
  for (const t of types) {
    const plain = t.n.replace(/<.*/, '').split('.').pop();
    if (!byShort.has(plain)) byShort.set(plain, t);
  }
  return { types, members, byId, namespaces, byFile, byShort, calls, methods: members.filter(CG.isMethod).length, info: m };
};

/** A stable name for a type, member or namespace, to find it again after the model is read again. */
CG.codeKey = function (x) {
  if (!x) return null;
  if (x.ck === 'type') return 'T:' + x.full;
  if (x.ck === 'member') return `M:${x.type.full}.${x.n}${x.s}`;
  if (x.ck === 'ns') return 'N:' + x.key;
  return null;
};
CG.findCode = function (code, key) {
  if (!code || !key) return null;
  const kind = key[0], rest = key.slice(2);
  if (kind === 'N') return code.namespaces.find((n) => n.key === rest) || null;
  if (kind === 'T') return code.types.find((t) => t.full === rest) || null;
  return code.members.find((x) => `${x.type.full}.${x.n}${x.s}` === rest) || null;
};

/** Types declared in a file or anywhere below a folder of the map. */
CG.typesUnder = function (code, node) {
  if (!code || !node) return [];
  if (!node.kids) return code.byFile.get(node.path.toLowerCase()) || [];
  const prefix = node.path ? node.path.toLowerCase() + '/' : '';
  return code.types.filter((t) => !/^[a-z]:|^\\\\/i.test(t.f) && t.f.toLowerCase().startsWith(prefix));
};

/** The method of a type with the most calls in and out: a good place to start its call graph. */
CG.busiest = function (members) {
  let best = null, most = -1;
  for (const x of members) {
    if (!CG.isMethod(x)) continue;
    const n = x.in.size + x.out.size;
    if (n > most) { most = n; best = x; }
  }
  return best;
};
