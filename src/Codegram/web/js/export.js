'use strict';
// Exporting what is on screen: an SVG drawing context the views draw into unchanged (they only use the 2D canvas
// calls below), and Mermaid text for the class diagram, call graph, flows and folder tree.

/** Enough of CanvasRenderingContext2D to record the views' drawing as SVG elements. */
CG.SvgContext = class {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.out = [];
    this.defs = [];
    this.clipCount = 0;
    this.path = '';
    this.px = 0;
    this.py = 0;
    this.state = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif', textAlign: 'start', globalAlpha: 1, dash: [], m: [1, 0, 0, 1, 0, 0], clip: null };
    this.stack = [];
    // text is measured as the browser would draw it
    this.measurer = document.createElement('canvas').getContext('2d');
  }

  get fillStyle() { return this.state.fillStyle; }
  set fillStyle(v) { this.state.fillStyle = v; }
  get strokeStyle() { return this.state.strokeStyle; }
  set strokeStyle(v) { this.state.strokeStyle = v; }
  get lineWidth() { return this.state.lineWidth; }
  set lineWidth(v) { this.state.lineWidth = v; }
  get font() { return this.state.font; }
  set font(v) { this.state.font = v; }
  get textAlign() { return this.state.textAlign; }
  set textAlign(v) { this.state.textAlign = v; }
  get globalAlpha() { return this.state.globalAlpha; }
  set globalAlpha(v) { this.state.globalAlpha = v; }

  save() { this.stack.push({ ...this.state, m: this.state.m.slice(), dash: this.state.dash.slice() }); }
  restore() { if (this.stack.length) this.state = this.stack.pop(); }
  setLineDash(d) { this.state.dash = d.slice(); }
  getLineDash() { return this.state.dash.slice(); }

  transform(a, b, c, d, e, f) {
    const [A, B, C, D, E, F] = this.state.m;
    this.state.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  }
  setTransform(a, b, c, d, e, f) { this.state.m = [a, b, c, d, e, f]; }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }

  n(v) { return Math.round(v * 100) / 100; }
  beginPath() { this.path = ''; }
  moveTo(x, y) { this.path += `M${this.n(x)} ${this.n(y)}`; this.px = x; this.py = y; }
  lineTo(x, y) { this.path += `L${this.n(x)} ${this.n(y)}`; this.px = x; this.py = y; }
  bezierCurveTo(a, b, c, d, x, y) { this.path += `C${this.n(a)} ${this.n(b)} ${this.n(c)} ${this.n(d)} ${this.n(x)} ${this.n(y)}`; this.px = x; this.py = y; }
  quadraticCurveTo(a, b, x, y) { this.path += `Q${this.n(a)} ${this.n(b)} ${this.n(x)} ${this.n(y)}`; this.px = x; this.py = y; }
  closePath() { this.path += 'Z'; }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }

  arc(x, y, r, a0, a1, ccw) {
    const sx = x + r * Math.cos(a0), sy = y + r * Math.sin(a0);
    this.path += this.path ? `L${this.n(sx)} ${this.n(sy)}` : `M${this.n(sx)} ${this.n(sy)}`;
    let sweep = ccw ? a0 - a1 : a1 - a0;
    if (sweep >= Math.PI * 2 - 1e-6) {
      // a full circle as two half arcs
      const mx = x - (sx - x), my = y - (sy - y);
      this.path += `A${this.n(r)} ${this.n(r)} 0 1 1 ${this.n(mx)} ${this.n(my)}A${this.n(r)} ${this.n(r)} 0 1 1 ${this.n(sx)} ${this.n(sy)}`;
      this.px = sx; this.py = sy;
      return;
    }
    sweep = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const ex = x + r * Math.cos(a1), ey = y + r * Math.sin(a1);
    this.path += `A${this.n(r)} ${this.n(r)} 0 ${sweep > Math.PI ? 1 : 0} ${ccw ? 0 : 1} ${this.n(ex)} ${this.n(ey)}`;
    this.px = ex; this.py = ey;
  }

  /** The rounded corner from the current point towards (x1, y1), then on towards (x2, y2). */
  arcTo(x1, y1, x2, y2, r) {
    const x0 = this.px, y0 = this.py;
    const ax = x0 - x1, ay = y0 - y1, bx = x2 - x1, by = y2 - y1;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb || 1))));
    const d = r / Math.tan(angle / 2 || 1);
    if (!la || !lb || !isFinite(d)) return this.lineTo(x1, y1);
    const t0x = x1 + (ax / la) * d, t0y = y1 + (ay / la) * d, t1x = x1 + (bx / lb) * d, t1y = y1 + (by / lb) * d;
    const cross = ax * by - ay * bx;
    this.lineTo(t0x, t0y);
    this.path += `A${this.n(r)} ${this.n(r)} 0 0 ${cross < 0 ? 1 : 0} ${this.n(t1x)} ${this.n(t1y)}`;
    this.px = t1x; this.py = t1y;
  }

  roundRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(typeof r === 'number' ? r : (r && r[0]) || 0, Math.abs(w) / 2, Math.abs(h) / 2));
    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y);
    if (r) this.path += `A${this.n(r)} ${this.n(r)} 0 0 1 ${this.n(x + w)} ${this.n(y + r)}`;
    this.lineTo(x + w, y + h - r);
    if (r) this.path += `A${this.n(r)} ${this.n(r)} 0 0 1 ${this.n(x + w - r)} ${this.n(y + h)}`;
    this.lineTo(x + r, y + h);
    if (r) this.path += `A${this.n(r)} ${this.n(r)} 0 0 1 ${this.n(x)} ${this.n(y + h - r)}`;
    this.lineTo(x, y + r);
    if (r) this.path += `A${this.n(r)} ${this.n(r)} 0 0 1 ${this.n(x + r)} ${this.n(y)}`;
    this.closePath();
  }

  attrs() {
    const s = this.state, m = s.m.map((v) => this.n(v)).join(' ');
    let a = m === '1 0 0 1 0 0' ? '' : ` transform="matrix(${m})"`;
    if (s.globalAlpha < 1) a += ` opacity="${this.n(s.globalAlpha)}"`;
    if (s.clip) a += ` clip-path="url(#${s.clip})"`;
    return a;
  }

  fill() { if (this.path) this.out.push(`<path d="${this.path}" fill="${this.state.fillStyle}"${this.attrs()}/>`); }
  stroke() {
    if (!this.path) return;
    const s = this.state, dash = s.dash.length ? ` stroke-dasharray="${s.dash.join(' ')}"` : '';
    this.out.push(`<path d="${this.path}" fill="none" stroke="${s.strokeStyle}" stroke-width="${this.n(s.lineWidth)}"${dash}${this.attrs()}/>`);
  }
  fillRect(x, y, w, h) { this.out.push(`<rect x="${this.n(x)}" y="${this.n(y)}" width="${this.n(w)}" height="${this.n(h)}" fill="${this.state.fillStyle}"${this.attrs()}/>`); }
  strokeRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.stroke(); }
  clearRect() {}

  clip() {
    const id = `c${++this.clipCount}`, m = this.state.m.map((v) => this.n(v)).join(' ');
    this.defs.push(`<clipPath id="${id}"><path d="${this.path}" transform="matrix(${m})"/></clipPath>`);
    this.state.clip = id;
  }

  measureText(text) {
    this.measurer.font = this.state.font;
    return this.measurer.measureText(text);
  }

  fillText(text, x, y) {
    const anchor = { center: 'middle', right: 'end', end: 'end' }[this.state.textAlign] || 'start';
    const font = this.state.font.replace(/Inter\b/, "Inter, 'Segoe UI', sans-serif");
    this.out.push(`<text x="${this.n(x)}" y="${this.n(y)}" fill="${this.state.fillStyle}" text-anchor="${anchor}" style="font:${CG.esc(font)};white-space:pre"${this.attrs()}>${CG.esc(text)}</text>`);
  }

  toString() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(this.w)}" height="${Math.ceil(this.h)}" viewBox="0 0 ${Math.ceil(this.w)} ${Math.ceil(this.h)}">` +
      (this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '') + this.out.join('') + '</svg>';
  }
};

// ── Mermaid ──
CG.mermaid = {};
const mmText = (s) => String(s).replace(/"/g, '#quot;').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
const mmGeneric = (s) => String(s).replace(/[<>]/g, '~');

/** A class diagram of the boxes the Classes view shows, with the members it lists. */
CG.mermaid.classes = function (view) {
  const lines = ['classDiagram'];
  const ids = new Map();
  view.boxes.forEach((b, i) => ids.set(b.t, `T${i}`));
  for (const b of view.boxes) {
    const t = b.t;
    lines.push(`  class ${ids.get(t)}["${mmText(t.n)}"] {`);
    if (b.stereo) lines.push(`    <<${b.stereo.replace(/[«»]/g, '')}>>`);
    for (const x of b.list) {
      const text = x.k === 'value' ? x.n : `${x.n}${x.s}`;
      lines.push(`    ${CG.ACCESS[x.a] === '−' ? '-' : CG.ACCESS[x.a] || ''}${mmGeneric(text)}${x.abs ? '*' : x.st ? '$' : ''}`);
    }
    if (b.more) lines.push(`    ${b.more} more`);
    lines.push('  }');
  }
  for (const e of view.hier) lines.push(`  ${ids.get(e.to.t)} ${e.kind === 'implement' ? '<|..' : '<|--'} ${ids.get(e.from.t)}`);
  for (const e of view.uses) lines.push(`  ${ids.get(e.from.t)} --> ${ids.get(e.to.t)}`);
  return lines.join('\n');
};

/** The call graph (or impact) on screen as a left-to-right flowchart. */
CG.mermaid.calls = function (view, focus) {
  const lines = ['flowchart LR'];
  const ids = new Map();
  view.items.filter((it) => !it.more).forEach((it, i) => {
    ids.set(it, `M${i}`);
    const m = it.member;
    const label = (it.entry && m.ui ? `${m.ui}<br/>` : '') + (m.k === 'ctor' ? `new ${m.type.n}` : `${m.type.n}.${m.n}`);
    lines.push(`  M${i}["${mmText(label).replace('&lt;br/&gt;', '<br/>')}"]`);
  });
  for (const e of view.edges) lines.push(`  ${ids.get(e.from)} --> ${ids.get(e.to)}`);
  const f = view.items.find((it) => it.member === focus || it.level === 0);
  if (f) lines.push(`  style ${ids.get(f)} stroke:#0a84ff,stroke-width:2px`);
  return lines.join('\n');
};

/** A flow as a Mermaid sequence diagram, opening the calls that are open on screen. */
CG.mermaid.sequence = function (data) {
  const lines = ['sequenceDiagram'];
  const parts = new Map();
  const part = (key, label) => {
    if (!parts.has(key)) {
      const id = `P${parts.size}`;
      parts.set(key, id);
      lines.splice(1 + parts.size - 1, 0, key === '@user' ? `  actor ${id} as User` : `  participant ${id} as ${mmText(label)}`);
    }
    return parts.get(key);
  };
  const colOf = (s, m) => {
    m = m || s.member;
    return m ? part('T:' + m.type.id, m.type.n) : part('X:' + (s.c || '').split('.')[0], (s.c || 'outside').split('.')[0]);
  };
  const entry = data.entry, root = data.root;
  const user = part('@user', 'User');
  const main = colOf(root);
  lines.push(`  ${user}->>+${main}: ${mmText(entry.ui || CG.flowLabel(root))}`);
  const walk = (steps, cur) => {
    for (const s of steps || []) {
      if (s.k === 'call') {
        const calls = s.b && s.b.length && s.open ? s.b.map((b) => [b.member, b.s, b.c]) : [[null, s.open ? s.s : null, null]];
        if (calls.length > 1) lines.push(`  alt ${mmText(CG.flowLabel(s))} goes to ${mmText(calls[0][2])}`);
        calls.forEach(([member, body, label], i) => {
          if (i) lines.push(`  else ${mmText(label)}`);
          const to = colOf(s, member);
          const m = member || s.member;
          const name = !m ? s.c : m.k === 'ctor' ? `new ${m.type.n}` : m.n;
          const out = CG.stepOut(s);
          const opened = body && body.length;
          lines.push(`  ${cur}->>${opened && to !== cur ? '+' : ''}${to}: ${mmText(`${s.no}. ${s.aw ? 'await ' : ''}${name}${m ? CG.argsText(s, 40) : ''}${!opened && out ? ` → ${out}` : ''}`)}`);
          if (opened) {
            walk(body, to);
            if (to !== cur) lines.push(`  ${to}-->>-${cur}: ${mmText(out || 'done')}`);
          }
        });
        if (calls.length > 1) lines.push('  end');
      } else if (s.k === 'loop') {
        lines.push(`  loop ${mmText(s.c)}`);
        walk(s.s, cur);
        lines.push('  end');
      } else if (s.k === 'if' || s.k === 'switch' || s.k === 'try') {
        const shown = s.b.filter((b, i) => b.s.length || (s.k !== 'if' && i === 0));
        if (!shown.length) continue;
        shown.forEach((b, i) => {
          const label = s.k === 'if' ? (i ? b.c : s.c) : s.k === 'try' ? b.c : `${s.c}: ${b.c}`;
          lines.push(i ? `  else ${mmText(label)}` : `  ${s.k === 'if' && shown.length === 1 ? 'opt' : 'alt'} ${mmText(label)}`);
          walk(b.s, cur);
        });
        lines.push('  end');
      } else lines.push(`  Note right of ${cur}: ${mmText(CG.flowLabel(s))}`);
    }
  };
  walk(root.s, main);
  lines.push(`  ${main}-->>-${user}: done`);
  return lines.join('\n');
};

/** A flow as a Mermaid flowchart of its steps, opening the calls that are open on screen. */
CG.mermaid.steps = function (data) {
  const lines = ['flowchart TD'];
  let n = 0;
  const id = () => `S${n++}`;
  const edge = (from, to, label) => lines.push(`  ${from} -->${label ? `|${mmText(label)}|` : ''} ${to}`);
  // returns the ids the next step should connect from
  const walk = (steps, ends) => {
    for (const s of steps || []) {
      const me = id();
      if (s.k === 'call') {
        const out = CG.stepOut(s);
        lines.push(`  ${me}["${mmText(`${s.no}. ${CG.flowLabel(s)}${s.member ? CG.argsText(s, 40) : ''}${out ? ` → ${out}` : ''}`)}"]`);
        ends.forEach((e) => edge(e, me));
        ends = [me];
        if (s.open && s.parent) {
          if (s.b && s.b.length) {
            const next = [];
            for (const b of s.b) next.push(...walk(b.s, [me]));
            ends = next.length ? next : [me];
          }
          if (s.s && s.s.length) ends = walk(s.s, ends);
        } else if (!s.parent) ends = walk(s.s, ends);
      } else if (s.k === 'if' || s.k === 'switch' || s.k === 'try') {
        lines.push(`  ${me}{"${mmText(CG.flowLabel(s))}"}`);
        ends.forEach((e) => edge(e, me));
        const next = [], pending = [];
        for (const b of s.b) {
          // an empty branch goes straight on to the join, labelled
          if (!b.s.length) { pending.push({ from: me, label: b.c }); continue; }
          const first = n;
          const branchEnds = walk(b.s, []);
          edge(me, `S${first}`, b.c);
          const last = b.s[b.s.length - 1];
          if (last.k !== 'return' && last.k !== 'throw') next.push(...branchEnds);
        }
        ends = next;
        if (pending.length) {
          const join = id();
          lines.push(`  ${join}(( ))`);
          pending.forEach((p) => edge(p.from, join, p.label));
          ends.forEach((e) => edge(e, join));
          ends = [join];
        }
      } else if (s.k === 'loop') {
        lines.push(`  ${me}(["${mmText('↻ ' + s.c)}"])`);
        ends.forEach((e) => edge(e, me));
        const bodyEnds = walk(s.s, [me]);
        bodyEnds.forEach((e) => lines.push(`  ${e} -.-> ${me}`));
        ends = [me];
      } else {
        lines.push(`  ${me}(["${mmText(CG.flowLabel(s))}"])`);
        ends.forEach((e) => edge(e, me));
        ends = [];
      }
    }
    return ends;
  };
  const start = id();
  lines.push(`  ${start}(("${mmText(data.entry.ui || 'Start')}"))`);
  walk([data.root], [start]);
  return lines.join('\n');
};

/** The folder tree (as far as it is open on screen, at most a few hundred items). */
CG.mermaid.tree = function (model, open) {
  const lines = ['flowchart LR'];
  let count = 0;
  const walk = (n, depth) => {
    const me = `F${n.id}`;
    lines.push(`  ${me}["${mmText(n.kids ? `${n.name}/` : n.name)}"]`);
    if (!n.kids || count > 300 || (depth > 0 && !open.has(n.path))) return;
    for (const k of n.kids) {
      if (++count > 300) break;
      walk(k, depth + 1);
      lines.push(`  ${me} --> F${k.id}`);
    }
  };
  walk(model.root, 0);
  return lines.join('\n');
};
