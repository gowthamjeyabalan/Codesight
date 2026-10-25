'use strict';
// Structure view: the solution's projects or namespaces and how they depend on each other, from what the code
// actually does (calls, uses, inheritance, fields, names). Arrows point from the user to what it uses; whatever
// depends on nothing sits at the bottom. Dependency cycles are red; project references nothing uses are dashed.

/** Projects or namespaces as nodes, with the uses between them as weighted edges, unused references and cycles. */
CG.structure = function (code, mode) {
  const keyOf = mode === 'projects' ? (t) => t.p || '(no project)' : (t) => t.ns || '(global namespace)';
  const nodes = new Map();
  const node = (key) => {
    let n = nodes.get(key);
    if (!n) nodes.set(key, (n = { key, label: key, types: [], methods: 0, out: new Map(), in: new Map(), declared: new Set(), sn: true }));
    return n;
  };
  for (const t of code.types) {
    const n = node(keyOf(t));
    n.types.push(t);
    n.methods += t.m.filter(CG.isMethod).length;
  }
  if (mode === 'projects') for (const p of code.info.projects || []) node(p);
  const of = (t) => nodes.get(keyOf(t));
  const edges = [];
  const add = (a, b, why) => {
    if (!a || !b || a === b) return;
    let e = a.out.get(b);
    if (!e) {
      e = { se: true, from: a, to: b, weight: 0, why: [] };
      a.out.set(b, e);
      b.in.set(a, e);
      edges.push(e);
    }
    e.weight++;
    if (e.why.length < 60) e.why.push(why);
  };
  for (const x of code.members) {
    const a = of(x.type);
    for (const y of x.out.keys()) add(a, of(y.type), { from: x, to: y, how: 'calls' });
    for (const y of x.refOut.keys()) add(a, of(y.type), { from: x, to: y, how: x.writeOut.has(y) ? 'writes' : y.k === 'method' ? 'passes on' : 'reads' });
  }
  for (const t of code.types) {
    const a = of(t), get = (id) => (id == null ? null : code.byId.get(id));
    const b = get(t.b);
    if (b) add(a, of(b), { from: t, to: b, how: 'inherits from' });
    for (const i of t.i) { const it = get(i); if (it) add(a, of(it), { from: t, to: it, how: 'implements' }); }
    for (const u of t.u) { const ut = get(u); if (ut) add(a, of(ut), { from: t, to: ut, how: 'has a' }); }
    for (const m of t.namedBy) add(of(m.type), a, { from: m, to: t, how: 'names' });
  }
  // project references: the ones the code never uses are worth removing
  const unused = [];
  if (mode === 'projects')
    for (const [from, to] of code.projectRefs) {
      const a = node(from), b = node(to);
      a.declared.add(b);
      if (!a.out.has(b)) unused.push({ se: true, unused: true, from: a, to: b, weight: 0, why: [] });
    }
  const list = [...nodes.values()];
  const cycles = CG.cycles(list);
  for (const c of cycles) for (const n of c) n.cycle = c;
  for (const e of edges) e.cycle = !!(e.from.cycle && e.from.cycle === e.to.cycle);
  return { mode, nodes: list, edges, unused, cycles };
};

/** Strongly connected groups of more than one node (Tarjan): each is a dependency cycle. */
CG.cycles = function (nodes) {
  let index = 0;
  const stack = [], on = new Set(), idx = new Map(), low = new Map(), out = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of v.out.keys()) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        on.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) out.push(group);
    }
  };
  for (const v of nodes) if (!idx.has(v)) visit(v);
  return out;
};

CG.StructureView = class {
  static GAP_X = 40;
  static GAP_Y = 96;
  static H = 48;

  constructor(app) {
    this.app = app;
    this.cam = new CG.Camera();
    this.key = '';
    this.fitPending = true;
    this.boxes = [];
    this.byNode = new Map();
  }

  pan(dx, dy) { this.cam.pan(dx, dy); }
  zoom(x, y, f) { this.cam.zoom(x, y, f); }

  layout(ctx) {
    const a = this.app, { GAP_X, GAP_Y, H } = CG.StructureView;
    const key = [a.codeVersion, a.structMode].join('|');
    if (key === this.key || !a.code) return;
    this.key = key;
    this.fitPending = true;
    const s = (this.s = a.structure = CG.structure(a.code, a.structMode));

    // each cycle is laid out as one block, so the rest stays a clean top-to-bottom order
    const group = new Map();
    for (const n of s.nodes) group.set(n, n.cycle || [n]);
    const groups = [...new Set(group.values())];
    const succ = new Map(groups.map((g) => [g, new Set()]));
    for (const e of s.edges) {
      const ga = group.get(e.from), gb = group.get(e.to);
      if (ga !== gb) succ.get(ga).add(gb);
    }
    // rank: the longest path down from anything nothing depends on
    const indeg = new Map(groups.map((g) => [g, 0]));
    for (const [, outs] of succ) for (const g of outs) indeg.set(g, indeg.get(g) + 1);
    const rank = new Map(), queue = groups.filter((g) => !indeg.get(g));
    for (const g of queue) rank.set(g, 0);
    while (queue.length) {
      const g = queue.shift();
      for (const h of succ.get(g)) {
        rank.set(h, Math.max(rank.get(h) || 0, rank.get(g) + 1));
        indeg.set(h, indeg.get(h) - 1);
        if (!indeg.get(h)) queue.push(h);
      }
    }
    const layers = [];
    for (const n of s.nodes) {
      const r = rank.get(group.get(n)) || 0;
      (layers[r] = layers[r] || []).push(n);
    }
    for (let i = 0; i < layers.length; i++) layers[i] = (layers[i] || []).sort((p, q) => p.label.localeCompare(q.label));

    // order each layer by where its neighbours are
    const pos = new Map();
    const index = () => layers.forEach((l) => l.forEach((n, i) => pos.set(n, i)));
    const bary = (n, near) => (near.length ? near.reduce((sum, m) => sum + pos.get(m), 0) / near.length : pos.get(n));
    index();
    for (let pass = 0; pass < 4; pass++) {
      for (let r = 1; r < layers.length; r++) { layers[r].sort((p, q) => bary(p, [...p.in.keys()]) - bary(q, [...q.in.keys()])); index(); }
      for (let r = layers.length - 2; r >= 0; r--) { layers[r].sort((p, q) => bary(p, [...p.out.keys()]) - bary(q, [...q.out.keys()])); index(); }
    }

    this.boxes = [];
    this.byNode.clear();
    let y = 0;
    for (const layer of layers) {
      const sized = layer.map((n) => {
        ctx.font = '600 12.5px Inter';
        const w1 = ctx.measureText(n.label).width;
        ctx.font = '11.5px Inter';
        const w2 = ctx.measureText(this.sub(n)).width;
        return { n, w: Math.min(300, Math.max(130, Math.ceil(Math.max(w1, w2) + 30))) };
      });
      const width = sized.reduce((sum, b) => sum + b.w, 0) + GAP_X * (sized.length - 1);
      let x = -width / 2;
      for (const b of sized) {
        const box = { node: b.n, x, y, w: b.w, h: H };
        this.boxes.push(box);
        this.byNode.set(b.n, box);
        x += b.w + GAP_X;
      }
      y += H + GAP_Y;
    }
  }

  sub(n) {
    return `${CG.plural(n.types.length, 'type')} · ${CG.plural(n.methods, 'method')}`;
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of this.boxes) {
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return { x0: x0 - 40, y0: y0 - 20, x1: x1 + 40, y1: y1 + 20 };
  }

  fit(ctx) {
    this.layout(ctx);
    if (this.boxes.length) this.cam.fit(this.bounds(), this.app.region, 1.1);
  }

  reveal(ctx, x) {
    this.layout(ctx);
    const b = x && this.byNode.get(x.se ? x.from : x);
    if (b && !this.cam.shows(b.x, b.y, b.w, b.h, this.app.region)) this.cam.center(b.x + b.w / 2, b.y + b.h / 2, this.app.region);
  }

  /** The curve of an edge: down from the user's bottom to the used box's top, or round the side when it goes up. */
  curve(e) {
    const a = this.byNode.get(e.from), b = this.byNode.get(e.to);
    if (!a || !b) return null;
    // spread the ends a little so several edges leaving one box stay apart
    const spread = (box, others, side) => {
      const list = [...others].map((n) => this.byNode.get(n)).filter(Boolean).sort((p, q) => p.x - q.x);
      const i = list.indexOf(side), k = list.length;
      return box.x + box.w / 2 + (k > 1 ? (i - (k - 1) / 2) * Math.min(18, (box.w - 30) / k) : 0);
    };
    if (b.y > a.y) {
      const x0 = spread(a, e.from.out.keys(), b), x1 = spread(b, e.to.in.keys(), a);
      const y0 = a.y + a.h, y1 = b.y, my = (y0 + y1) / 2;
      return { pts: [x0, y0, x0, my, x1, my, x1, y1], end: [x1, y1], angle: Math.PI / 2 };
    }
    if (b.y === a.y) {
      // side by side (a cycle): rightwards arcs over the top, leftwards ones underneath, so a pair never overlaps
      const right = b.x > a.x, y0 = right ? a.y : a.y + a.h, lift = right ? -34 : 34;
      const x0 = a.x + a.w / 2, x1 = b.x + b.w / 2;
      return { pts: [x0, y0, x0, y0 + lift, x1, y0 + lift, x1, y0], end: [x1, y0], angle: right ? Math.PI / 2 : -Math.PI / 2 };
    }
    // upwards (inside a cycle): out of the right side, round, into the right side
    const x0 = a.x + a.w, y0 = a.y + a.h / 2, x1 = b.x + b.w, y1 = b.y + b.h / 2;
    const bulge = 40 + Math.abs(y1 - y0) * 0.25;
    return { pts: [x0, y0, Math.max(x0, x1) + bulge, y0, Math.max(x0, x1) + bulge, y1, x1 + 2, y1], end: [x1 + 2, y1], angle: Math.PI };
  }

  draw(ctx, t) {
    this.layout(ctx);
    if (this.fitPending) { this.fit(ctx); this.fitPending = false; }
    const a = this.app, sel = a.ssel, r = a.region;
    if (!this.boxes.length) {
      ctx.fillStyle = t.text2;
      ctx.font = '13px Inter';
      ctx.textAlign = 'center';
      ctx.fillText('No C# code to map.', r.x + r.w / 2, r.y + r.h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const s = this.s;
    ctx.save();
    this.cam.apply(ctx);
    const selNode = sel && !sel.se ? sel : null;
    const drawEdge = (e, dashed) => {
      const c = this.curve(e);
      if (!c) return;
      const hot = sel === e || (selNode && (e.from === selNode || e.to === selNode));
      ctx.strokeStyle = e.cycle ? t.danger : hot ? t.accent : dashed ? t.edgeSoft : t.edge;
      ctx.globalAlpha = selNode && !hot && !e.cycle ? 0.35 : 1;
      ctx.lineWidth = dashed ? 1.2 : Math.min(5, 1 + Math.log2(e.weight + 1) * 0.7) * (hot ? 1.2 : 1);
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      const p = c.pts;
      ctx.moveTo(p[0], p[1]);
      ctx.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]);
      ctx.stroke();
      ctx.setLineDash([]);
      CG.arrow(ctx, c.end[0], c.end[1], c.angle, 8, false);
      ctx.globalAlpha = 1;
    };
    for (const e of s.unused) drawEdge(e, true);
    for (const e of s.edges) if (!e.cycle) drawEdge(e, false);
    for (const e of s.edges) if (e.cycle) drawEdge(e, false);

    for (const b of this.boxes) {
      const n = b.node, isSel = n === sel, hov = n === a.hover;
      const faded = selNode && !isSel && !selNode.out.has(n) && !selNode.in.has(n);
      ctx.globalAlpha = faded ? 0.45 : 1;
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 10);
      ctx.fillStyle = hov ? t.cardHover : t.card;
      ctx.fill();
      ctx.lineWidth = isSel || n.cycle ? 2 : 1;
      ctx.strokeStyle = isSel ? t.accent : n.cycle ? t.danger : t.cardStroke;
      ctx.stroke();
      ctx.font = '600 12.5px Inter';
      ctx.fillStyle = t.text;
      ctx.textAlign = 'center';
      ctx.fillText(CG.fit(ctx, n.label, b.w - 20), b.x + b.w / 2, b.y + 20);
      ctx.font = '11.5px Inter';
      ctx.fillStyle = t.text2;
      ctx.fillText(CG.fit(ctx, this.sub(n), b.w - 20), b.x + b.w / 2, b.y + 36);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  hit(sx, sy) {
    const [x, y] = this.cam.toWorld(sx, sy);
    for (const b of this.boxes) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.node;
    // edges: near any sampled point of the curve
    const near = 7 / this.cam.k;
    for (const e of [...(this.s ? this.s.edges : []), ...(this.s ? this.s.unused : [])]) {
      const c = this.curve(e);
      if (!c) continue;
      const p = c.pts;
      for (let i = 0; i <= 24; i++) {
        const u = i / 24, v = 1 - u;
        const px = v * v * v * p[0] + 3 * v * v * u * p[2] + 3 * v * u * u * p[4] + u * u * u * p[6];
        const py = v * v * v * p[1] + 3 * v * v * u * p[3] + 3 * v * u * u * p[5] + u * u * u * p[7];
        if (Math.abs(px - x) < near && Math.abs(py - y) < near) return e;
      }
    }
    return null;
  }
};
