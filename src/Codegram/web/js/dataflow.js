'use strict';
// What moves through a flow: the type each call gives back, the shape of those types (their fields, opened up),
// and where one value goes from step to step.

/** Task<T> and ValueTask<T> give T once awaited; a bare Task gives nothing. */
CG.unwrapTask = function (r) {
  const m = /^(?:Task|ValueTask)<(.+)>$/.exec(r);
  if (m) return m[1];
  return /^(?:Task|ValueTask)$/.test(r) ? null : r;
};

/** The type a call step gives back (after await), or null for void. */
CG.stepType = function (s) {
  const m = s.member;
  if (!m) return null;
  const r = m.k === 'ctor' ? m.type.n : m.r;
  if (!r) return null;
  return s.aw ? CG.unwrapTask(r) : r;
};

/** "raw: List<string[]>", "returns ConversionResult" or just the type: where a call's result goes. */
CG.stepOut = function (s) {
  const type = CG.stepType(s);
  if (s.v === 'return') return type ? `returns ${type}` : 'returned';
  if (s.v) return type ? `${s.v}: ${type}` : s.v;
  return type || '';
};

CG.argsText = function (s, max = 40) {
  if (!s.a) return '()';
  const t = `(${s.a.join(', ')})`;
  return t.length > max ? t.slice(0, max - 2) + '…)' : t;
};

/** Types of the solution named in a type text: "List<OrderLine>" names OrderLine. */
CG.typesIn = function (code, text) {
  if (!code || !text) return [];
  const out = [];
  for (const n of text.match(/[A-Za-z_]\w*/g) || []) {
    const t = code.byShort.get(n);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};

/** The data a type holds: its instance properties and fields, the public ones when there are any. */
CG.dataMembers = function (t) {
  const inst = t.m.filter((x) => (x.k === 'prop' || x.k === 'field') && !x.st);
  const open = inst.filter((x) => x.a !== 'private' && x.a !== 'private protected');
  return (open.length ? open : inst).slice(0, 24);
};

/** A tree of the types named in `text`: each with its fields, and the solution's types inside them opened up. */
CG.shapeHtml = function (code, text, depth = 0, seen = new Set()) {
  let h = '';
  for (const t of CG.typesIn(code, text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    h += `<div class="shape-type" data-k="type" data-id="${t.id}"><span class="dot" style="background:${CG.kindColor(t.k)}"></span>` +
      `<span class="shape-name">${CG.esc(t.n)}</span><span class="hint">${CG.esc(t.k)}</span></div>`;
    if (t.k === 'enum') {
      h += `<div class="shape-kids"><div class="shape-row hint">${CG.esc(t.m.map((x) => x.n).join(' | '))}</div></div>`;
      continue;
    }
    const fields = CG.dataMembers(t);
    if (!fields.length) continue;
    h += '<div class="shape-kids">';
    for (const x of fields) {
      h += `<div class="shape-row" data-k="member" data-id="${x.id}"><span>${CG.esc(x.n)}</span><span class="hint">: ${CG.esc(x.r || '')}</span></div>`;
      if (depth < 2 && x.r) {
        const inner = CG.shapeHtml(code, x.r, depth + 1, seen);
        if (inner) h += `<div class="shape-kids">${inner}</div>`;
      }
    }
    h += '</div>';
  }
  return h;
};

/** The call a step runs inside (the method whose body it is in). */
CG.enclosing = function (s) {
  for (let p = s.parent; p; p = p.parent) if (p.k === 'call') return p;
  return null;
};

/**
 * What a flow produces: the entry's own result, then the solution's types given back by calls, nearest calls
 * first. Each output is { type, text, from }.
 */
CG.flowOutputs = function (data, code) {
  const out = [];
  const add = (text, from) => {
    for (const t of CG.typesIn(code, text)) if (!out.some((o) => o.type === t)) out.push({ type: t, text, from });
  };
  const entryType = data.entry.r && CG.unwrapTask(data.entry.r);
  if (entryType) add(entryType, data.root);
  let level = [data.root];
  for (let depth = 0; depth < 4 && level.length && out.length < 4; depth++) {
    const next = [];
    const visit = (list) => {
      for (const s of list || []) {
        if (s.k === 'call') {
          add(CG.stepType(s), s);
          next.push(s);
        } else {
          visit(s.s);
          for (const b of s.b || []) visit(b.s);
        }
      }
    };
    for (const s of level) {
      visit(s.s);
      for (const b of s.b || []) visit(b.s);
    }
    level = next;
  }
  return out.slice(0, 4);
};

/** Identifiers in an argument worth following: "raw[r]" gives raw, "result.Rows" gives result. */
CG.followable = function (text) {
  const m = /^(?:this\.)?([A-Za-z_]\w*)/.exec(text || '');
  if (!m || /^(new|true|false|null|await|typeof|nameof|default)$/.test(m[1])) return null;
  return m[1];
};

/**
 * Where a value goes: starting in the method of `scope` (a call step) with the name `name`, the steps that make
 * it, take it (and on into the called method under its parameter name), check it, return it (and on in the
 * caller under the name its result is stored in) or throw it. Returns a Map of step to role.
 */
CG.traceValue = function (scope, name) {
  const roles = new Map(), seen = new Set();
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // words inside string literals are text, not the value
  const code = (text) => text.replace(/@?\$?"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)'/g, "''");
  const uses = (text, n) => !!text && new RegExp(`(^|[^\\w.])${esc(n)}(?![\\w])`).test(code(text));
  const mark = (s, role) => { if (!roles.has(s)) roles.set(s, role); };

  const back = (from) => {
    if (!from.parent) return;
    mark(from, 'gives it back');
    const up = CG.enclosing(from);
    if (!up) return;
    if (from.v === 'return') back(up);
    else if (from.v) walk(up, from.v);
  };

  const walk = (sc, n) => {
    const key = (sc.no || 0) + ':' + n;
    if (seen.has(key)) return;
    seen.add(key);
    if (sc.parent && sc.member && sc.member.pn && sc.member.pn.includes(n)) mark(sc, 'passes it in');
    let returned = (sc.rv || []).some((r) => uses(r, n));
    const step = (s) => {
      if (s.k === 'call') {
        if (s.v === n) {
          mark(s, 'makes it');
          // a value that comes back from a call was built inside it: follow it there too
          if (s.s) for (const r of s.rv || []) {
            const inner = CG.followable(r);
            if (inner) walk(s, inner);
          }
        }
        if (uses(s.on, n)) mark(s, 'works on it');
        (s.a || []).forEach((arg, i) => {
          if (!uses(arg, n)) return;
          mark(s, 'takes it');
          const p = s.member && s.member.pn && s.member.pn[i];
          if (p && s.s) walk(s, p);
          for (const b of s.b || []) {
            const bp = b.member && b.member.pn && b.member.pn[i];
            if (bp) walk({ s: b.s, member: b.member, parent: s.parent, rv: s.rv, v: s.v, no: `${s.no}${b.c}` }, bp);
          }
        });
      } else if (s.k === 'return' || s.k === 'throw') {
        if (uses(s.c, n)) {
          mark(s, s.k === 'return' ? 'returns it' : 'throws it');
          if (s.k === 'return') returned = true;
        }
      } else {
        if (uses(s.c, n)) mark(s, 'checks it');
        (s.s || []).forEach(step);
        for (const b of s.b || []) b.s.forEach(step);
      }
    };
    (sc.s || []).forEach(step);
    if (returned) back(sc);
  };

  walk(scope, name);
  return roles;
};
