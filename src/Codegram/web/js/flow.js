'use strict';
// Flow view: what runs when something starts (a button click, a command, an API call, any method), in order.
// Two drawings of the same steps: a sequence diagram (a column per class, calls going down in time) and a
// flowchart of numbered steps with decisions, loops and try blocks. Calls open and close with a double-click.

/** Links the steps from FlowAnalyzer.cs to the code model and numbers the calls in the order they run. */
CG.prepareFlow = function (root, code, entry) {
  let no = 0, calls = 0, stopped = false;
  const classes = new Set();
  const walk = (s, parent, depth) => {
    s.parent = parent;
    s.depth = depth;
    if (s.k === 'call') {
      s.member = s.m != null ? code.byId.get(s.m) || null : null;
      s.no = ++no;
      calls++;
      if (s.member) classes.add(s.member.type);
      s.open = depth < 3;
      if (s.x === 'budget') stopped = true;
    }
    if (s.s) for (const c of s.s) walk(c, s, depth + 1);
    if (s.b)
      for (const b of s.b) {
        b.member = b.m != null ? code.byId.get(b.m) || null : null;
        if (b.member) classes.add(b.member.type);
        for (const c of b.s) walk(c, s, depth + 1);
      }
  };
  walk(root, null, 0);
  root.open = true;
  const byNo = new Map();
  const index = (s) => {
    if (s.k === 'call') byNo.set(s.no, s);
    (s.s || []).forEach(index);
    (s.b || []).forEach((b) => b.s.forEach(index));
  };
  index(root);
  return { root, entry, calls, classes: classes.size, stopped, byNo };
};

CG.canOpen = (s) => s.k === 'call' && s.parent != null && ((s.s && s.s.length) || (s.b && s.b.length));

CG.flowLabel = function (s) {
  switch (s.k) {
    case 'call':
      if (!s.member) return s.c || 'call';
      return s.member.k === 'ctor' ? `new ${s.member.type.n}` : `${s.member.type.n}.${s.member.n}`;
    case 'if': return `if ${s.c}`;
    case 'switch': return `switch ${s.c}`;
    case 'try': return 'try';
    case 'return': return s.c ? `return ${s.c}` : 'return';
    case 'throw': return `throw ${s.c}`;
    default: return s.c || s.k;
  }
};

const STOP_TEXT = { seen: 'shown earlier', recursion: 'calls itself', depth: 'too deep', budget: 'stopped' };

CG.FlowView = class {
  constructor(app) {
    this.app = app;
    this.cam = new CG.Camera();
    this.key = '';
    this.fitPending = true;
    this.hits = [];
  }

  pan(dx, dy) { this.cam.pan(dx, dy); }
  zoom(x, y, f) { this.cam.zoom(x, y, f); }

  layout(ctx) {
    const a = this.app, f = a.flow;
    const key = [a.flowVersion, a.flowStyle, f && f.state].join('|');
    if (key === this.key) return;
    this.key = key;
    // fit when another flow arrives or the drawing style changes, not when a step opens or closes
    const fitKey = [a.flowLoads, a.flowStyle, f && f.state].join('|');
    if (fitKey !== this.fitKey) {
      this.fitKey = fitKey;
      this.fitPending = true;
    }
    this.hits = [];
    this.ops = null;
    if (!f || f.state !== 'ready') return;
    this.ops = a.flowStyle === 'steps' ? new StepsLayout(ctx, this).run(f.data) : new SequenceLayout(ctx, this).run(f.data);
  }

  bounds() {
    return this.ops ? this.ops.bounds : { x0: 0, y0: 0, x1: 1, y1: 1 };
  }

  /** Flows read top to bottom like a page: fit the width (never too small to read) and start at the top. */
  fit(ctx) {
    this.layout(ctx);
    if (!this.ops) return;
    const b = this.bounds(), r = this.app.region, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const whole = Math.min((r.w - 40) / bw, (r.h - 40) / bh, 1.1);
    const k = whole >= 0.75 ? whole : Math.max(0.75, Math.min((r.w - 40) / bw, 1.1));
    this.cam.k = k;
    this.cam.x = bw * k <= r.w ? r.x + (r.w - bw * k) / 2 - b.x0 * k : r.x + 20 - b.x0 * k;
    this.cam.y = bh * k <= r.h ? r.y + (r.h - bh * k) / 2 - b.y0 * k : r.y + 20 - b.y0 * k;
  }

  reveal(ctx, s) {
    this.layout(ctx);
    const h = this.hits.find((x) => x.s === s);
    if (h && !this.cam.shows(h.x, h.y, h.w, h.h, this.app.region)) this.cam.center(h.x + h.w / 2, h.y + h.h / 2, this.app.region);
  }

  draw(ctx, t) {
    this.layout(ctx);
    const a = this.app, r = a.region, f = a.flow;
    if (!f || f.state !== 'ready') {
      ctx.fillStyle = f && f.state === 'error' ? t.danger : t.text2;
      ctx.font = '13px Inter';
      ctx.textAlign = 'center';
      const msg = !a.flowEntry ? 'Pick a starting point in the panel on the left.' : f && f.state === 'error' ? f.error : 'Following the code…';
      ctx.fillText(msg, r.x + r.w / 2, r.y + r.h / 2);
      ctx.textAlign = 'left';
      return;
    }
    if (this.fitPending) { this.fit(ctx); this.fitPending = false; }
    ctx.save();
    this.cam.apply(ctx);
    this.ops.draw(ctx, t, this.cam);
    ctx.restore();
  }

  hit(sx, sy) {
    const [x, y] = this.cam.toWorld(sx, sy);
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h.s;
    }
    return null;
  }
};

// ── shared drawing bits ──
function callParts(s) {
  if (!s.member) return { type: '', name: s.c || 'call', outside: true };
  const m = s.member;
  return { type: m.k === 'ctor' ? 'new ' : m.type.n + '.', name: m.k === 'ctor' ? m.type.n : m.n, outside: false };
}

function hexagon(ctx, x, y, w, h) {
  const e = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + e, y);
  ctx.lineTo(x + w - e, y);
  ctx.lineTo(x + w, y + h / 2);
  ctx.lineTo(x + w - e, y + h);
  ctx.lineTo(x + e, y + h);
  ctx.lineTo(x, y + h / 2);
  ctx.closePath();
}

function bounds(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of list) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x0, y0, x1, y1 };
}

// ── steps: a flowchart, every block centred on one spine, entry at the top and exit at the bottom ──
class StepsLayout {
  static NH = 28;
  static GAP = 20;
  static IND = 22;
  static BGAP = 28;

  constructor(ctx, view) {
    this.ctx = ctx;
    this.view = view;
    this.app = view.app;
    this.nodes = [];
    this.lines = [];
    this.frames = [];
    this.labels = [];
  }

  width(text, font) {
    this.ctx.font = font;
    return this.ctx.measureText(text).width;
  }

  run(data) {
    const entry = data.entry;
    const start = { k: 'start', c: entry.ui || 'Start', parent: null };
    const blk = this.list([start, data.root]);
    blk.place(-blk.w / 2, 0);
    const all = [...this.nodes, ...this.frames];
    const b = bounds(all);
    this.view.hits = this.nodes.map((n) => ({ s: n.s, x: n.x, y: n.y, w: n.w, h: n.h }));
    return { bounds: { x0: b.x0 - 20, y0: b.y0 - 20, x1: b.x1 + 20, y1: b.y1 + 20 }, draw: (ctx, t) => this.draw(ctx, t) };
  }

  list(steps) {
    const { GAP } = StepsLayout;
    const blocks = steps.map((s) => this.step(s));
    if (!blocks.length) return { w: 0, h: 0, place() {} };
    const w = Math.max(...blocks.map((b) => b.w));
    const h = blocks.reduce((sum, b) => sum + b.h, 0) + GAP * (blocks.length - 1);
    return {
      w, h,
      place: (x, y) => {
        const cx = x + w / 2;
        let yy = y;
        blocks.forEach((b, i) => {
          if (i) this.lines.push({ pts: [[cx, yy - GAP], [cx, yy]], arrow: true });
          b.place(cx - b.w / 2, yy);
          yy += b.h + GAP;
        });
      },
    };
  }

  /** Two blocks one after the other. */
  seq(a, b) {
    if (!a.h) return b;
    if (!b.h) return a;
    const { GAP } = StepsLayout;
    const w = Math.max(a.w, b.w);
    return {
      w, h: a.h + GAP + b.h,
      place: (x, y) => {
        const cx = x + w / 2;
        a.place(cx - a.w / 2, y);
        this.lines.push({ pts: [[cx, y + a.h], [cx, y + a.h + GAP]], arrow: true });
        b.place(cx - b.w / 2, y + a.h + GAP);
      },
    };
  }

  /** Columns side by side that split from one point and join again. */
  branches(list, labelOf) {
    const { BGAP } = StepsLayout;
    const LBL = 28, JOIN = 18;
    const cols = list.map((b) => {
      const blk = this.list(b.s);
      const label = labelOf(b);
      const last = b.s[b.s.length - 1];
      // a branch that returns or throws ends there instead of joining the others
      const ends = !!last && (last.k === 'throw' || last.k === 'return');
      return { blk, label, ends, w: Math.max(blk.w, this.width(label, '600 11px Inter') + 18, 70) };
    });
    const w = cols.reduce((sum, c) => sum + c.w, 0) + BGAP * (cols.length - 1);
    const h = LBL + Math.max(0, ...cols.map((c) => c.blk.h)) + JOIN;
    return {
      w, h,
      place: (x, y) => {
        const mid = x + w / 2;
        let cx = x;
        for (const c of cols) {
          const center = cx + c.w / 2;
          this.lines.push({ pts: [[mid, y], [mid, y + 6], [center, y + 6], [center, y + LBL]], arrow: true });
          this.labels.push({ x: center, y: y + 17, text: c.label });
          c.blk.place(center - c.blk.w / 2, y + LBL);
          const bottom = y + LBL + c.blk.h;
          if (!c.ends) this.lines.push({ pts: [[center, bottom], [center, y + h - 6], [mid, y + h - 6], [mid, y + h]] });
          cx += c.w + BGAP;
        }
      },
    };
  }

  step(s) {
    const { NH, IND } = StepsLayout;
    switch (s.k) {
      case 'start': {
        const w = Math.max(110, this.width('▶  ' + s.c, '600 12px Inter') + 30);
        return { w, h: NH, place: (x, y) => this.nodes.push({ s, kind: 'start', x, y, w, h: NH }) };
      }
      case 'call': {
        const p = callParts(s);
        let w = 40 + this.width(String(s.no), '11px Inter') + this.width(p.type, '11.5px Inter') + this.width(p.name, '600 12px Inter');
        if (s.aw) w += this.width('await ', 'italic 11.5px Inter');
        if (s.x) w += this.width(STOP_TEXT[s.x], '11px Inter') + 14;
        if (s.member) w += this.width(CG.argsText(s, 34), '11.5px Inter');
        const out = CG.stepOut(s);
        if (out) w += this.width('  → ' + out, '11px Inter');
        if (CG.canOpen(s)) w += 14;
        w = Math.min(560, Math.max(130, Math.ceil(w)));
        let body = null;
        if (s.open && (s.b || s.s)) {
          const alts = s.b && s.b.length ? this.branches(s.b, (b) => (s.b.length > 1 ? b.c : `in ${b.c}`)) : { w: 0, h: 0, place() {} };
          body = this.seq(alts, this.list(s.s || []));
        }
        if (!body || !body.h) return { w, h: NH, place: (x, y) => this.nodes.push({ s, kind: 'call', x, y, w, h: NH }) };
        const bw = Math.max(w, body.w + 2 * IND), bh = NH + 12 + body.h + 14;
        return {
          w: bw, h: bh,
          place: (x, y) => {
            const cx = x + bw / 2, fw = body.w + 2 * IND - 8;
            this.frames.push({ s, x: cx - fw / 2, y: y + NH / 2, w: fw, h: bh - NH / 2 });
            this.nodes.push({ s, kind: 'call', x: cx - w / 2, y, w, h: NH });
            this.lines.push({ pts: [[cx, y + NH], [cx, y + NH + 12]], arrow: true });
            body.place(cx - body.w / 2, y + NH + 12);
            this.lines.push({ pts: [[cx, y + NH + 12 + body.h], [cx, y + bh]] });
          },
        };
      }
      case 'if':
      case 'switch':
      case 'try': {
        const DH = 30;
        const text = CG.flowLabel(s);
        const dw = Math.min(420, Math.max(90, this.width(text, '500 12px Inter') + 44));
        const blk = this.branches(s.b, (b) => b.c);
        const w = Math.max(dw, blk.w);
        return {
          w, h: DH + blk.h,
          place: (x, y) => {
            const cx = x + w / 2;
            this.nodes.push({ s, kind: 'decision', x: cx - dw / 2, y, w: dw, h: DH, text });
            blk.place(cx - blk.w / 2, y + DH);
          },
        };
      }
      case 'loop': {
        const text = '↻  ' + s.c;
        const hw = Math.min(420, Math.max(110, this.width(text, '500 12px Inter') + 28));
        const body = this.list(s.s || []);
        const w = Math.max(hw, body.w + 2 * IND + 12), h = NH + 12 + body.h + 20;
        return {
          w, h,
          place: (x, y) => {
            const cx = x + w / 2, bb = y + NH + 12 + body.h, lx = cx - body.w / 2 - IND;
            this.nodes.push({ s, kind: 'loop', x: cx - hw / 2, y, w: hw, h: NH, text });
            this.lines.push({ pts: [[cx, y + NH], [cx, y + NH + 12]], arrow: true });
            body.place(cx - body.w / 2, y + NH + 12);
            this.lines.push({ pts: [[cx, bb], [cx, bb + 10], [lx, bb + 10], [lx, y + NH / 2], [cx - hw / 2, y + NH / 2]], arrow: true });
            this.lines.push({ pts: [[cx, bb + 10], [cx, y + h]] });
          },
        };
      }
      default: {
        // return and throw end the path
        const text = CG.flowLabel(s);
        const w = Math.min(380, Math.max(80, this.width(text, '500 12px Inter') + 26));
        return { w, h: 24, place: (x, y) => this.nodes.push({ s, kind: s.k, x, y, w, h: 24, text }) };
      }
    }
  }

  draw(ctx, t) {
    const a = this.app, sel = a.fsel, hov = a.hover;
    for (const f of this.frames) {
      ctx.beginPath();
      ctx.roundRect(f.x, f.y, f.w, f.h, 10);
      ctx.fillStyle = t.hoverSoft;
      ctx.fill();
      ctx.fillStyle = f.s.member ? CG.kindColor(f.s.member.type.k) : t.text2;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(f.x, f.y + 14, 2.5, f.h - 28);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = t.edge;
    ctx.lineWidth = 1.3;
    for (const l of this.lines) {
      ctx.beginPath();
      l.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      if (l.arrow) {
        const [x0, y0] = l.pts[l.pts.length - 2], [x1, y1] = l.pts[l.pts.length - 1];
        if (x0 !== x1 || y0 !== y1) CG.arrow(ctx, x1, y1, Math.atan2(y1 - y0, x1 - x0), 7, false);
      }
    }
    ctx.textAlign = 'center';
    for (const l of this.labels) {
      ctx.font = '600 11px Inter';
      const w = ctx.measureText(l.text).width + 12;
      ctx.beginPath();
      ctx.roundRect(l.x - w / 2, l.y - 9, w, 16, 8);
      ctx.fillStyle = t.labelBg;
      ctx.fill();
      ctx.fillStyle = t.text2;
      ctx.fillText(l.text, l.x, l.y + 3);
    }
    ctx.textAlign = 'left';

    const trace = a.trace;
    for (const n of this.nodes) {
      const s = n.s, isSel = s === sel, isHov = s === hov;
      const role = trace && trace.roles.get(s);
      // a followed value: its steps stand out, the rest steps back
      ctx.globalAlpha = trace && !role && n.kind !== 'start' ? 0.3 : 1;
      if (role) this.roleTag(ctx, t, role, n);
      ctx.lineWidth = isSel || role ? 2 : 1;
      ctx.strokeStyle = isSel || role ? t.accent : t.cardStroke;
      if (n.kind === 'decision') {
        hexagon(ctx, n.x, n.y, n.w, n.h);
        ctx.fillStyle = isHov ? t.cardHover : t.card;
        ctx.fill();
        if (!isSel) ctx.strokeStyle = t.text2;
        ctx.stroke();
        ctx.font = '500 12px Inter';
        ctx.fillStyle = t.text;
        ctx.textAlign = 'center';
        ctx.fillText(CG.fit(ctx, n.text, n.w - 36), n.x + n.w / 2, n.y + n.h / 2 + 4);
        ctx.textAlign = 'left';
        continue;
      }
      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.w, n.h, n.kind === 'call' ? 8 : n.h / 2);
      ctx.fillStyle = n.kind === 'start' ? t.accentSoft : isHov ? t.cardHover : t.card;
      ctx.fill();
      if (n.kind === 'start' && !isSel) ctx.strokeStyle = t.accent;
      ctx.stroke();
      const mid = n.y + n.h / 2 + 4;
      if (n.kind === 'call') {
        const p = callParts(s);
        let x = n.x + 9;
        ctx.font = '11px Inter';
        ctx.fillStyle = t.text2;
        ctx.fillText(String(s.no), x, mid);
        x += ctx.measureText(String(s.no)).width + 7;
        ctx.beginPath();
        ctx.arc(x + 3, n.y + n.h / 2, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = s.member ? CG.kindColor(s.member.type.k) : t.text2;
        ctx.fill();
        x += 12;
        if (s.aw) {
          ctx.font = 'italic 11.5px Inter';
          ctx.fillStyle = t.accentText;
          ctx.fillText('await ', x, mid);
          x += ctx.measureText('await ').width;
        }
        ctx.font = '11.5px Inter';
        ctx.fillStyle = t.text2;
        ctx.fillText(p.type, x, mid);
        x += ctx.measureText(p.type).width;
        ctx.font = '11px Inter';
        const end = n.x + n.w - (CG.canOpen(s) ? 22 : 10) - (s.x ? ctx.measureText(STOP_TEXT[s.x]).width + 12 : 0);
        ctx.font = p.outside ? 'italic 12px Inter' : '600 12px Inter';
        ctx.fillStyle = p.outside ? t.text2 : t.text;
        const name = CG.fit(ctx, p.name, end - x);
        ctx.fillText(name, x, mid);
        x += ctx.measureText(name).width;
        // what goes in, and where the result goes
        if (s.member && name === p.name) {
          ctx.font = '11.5px Inter';
          ctx.fillStyle = t.text2;
          const args = CG.fit(ctx, CG.argsText(s, 34), end - x);
          ctx.fillText(args, x, mid);
          x += ctx.measureText(args).width;
          const out = CG.stepOut(s);
          if (out && x < end - 20) {
            ctx.font = '11px Inter';
            ctx.fillStyle = t.accentText;
            ctx.fillText(CG.fit(ctx, '  → ' + out, end - x), x, mid);
          }
        }
        if (s.x) {
          ctx.font = '11px Inter';
          ctx.fillStyle = t.text2;
          const tx = STOP_TEXT[s.x];
          ctx.fillText(tx, n.x + n.w - (CG.canOpen(s) ? 22 : 10) - ctx.measureText(tx).width, mid);
        }
        if (CG.canOpen(s)) {
          ctx.font = '9px Inter';
          ctx.fillStyle = t.text2;
          ctx.fillText(s.open ? '▾' : '▸', n.x + n.w - 15, mid - 1);
        }
      } else {
        ctx.font = n.kind === 'start' ? '600 12px Inter' : '500 12px Inter';
        ctx.fillStyle = n.kind === 'throw' ? t.danger : n.kind === 'return' ? t.text2 : t.text;
        ctx.textAlign = 'center';
        const text = n.kind === 'start' ? '▶  ' + s.c : n.text;
        ctx.fillText(CG.fit(ctx, text, n.w - 20), n.x + n.w / 2, mid);
        ctx.textAlign = 'left';
      }
    }
    ctx.globalAlpha = 1;
  }

  /** What a step does with the followed value, to the right of it. */
  roleTag(ctx, t, role, n) {
    ctx.font = '600 11px Inter';
    const w = ctx.measureText(role).width + 14;
    ctx.beginPath();
    ctx.roundRect(n.x + n.w + 8, n.y + n.h / 2 - 9, w, 18, 9);
    ctx.fillStyle = t.accent;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(role, n.x + n.w + 15, n.y + n.h / 2 + 4);
  }
}

// ── sequence: a column per class, calls going down the page in the order they happen ──
class SequenceLayout {
  static ROW = 34;

  constructor(ctx, view) {
    this.ctx = ctx;
    this.view = view;
    this.app = view.app;
    this.cols = [];
    this.colOf = new Map();
    this.arrows = [];
    this.acts = [];
    this.frags = [];
    this.notes = [];
    this.open = []; // fragments being filled, to widen them to the columns their calls reach
    this.nest = new Map(); // column -> activations open on it
    this.y = 0;
  }

  col(key, label, kind) {
    if (!this.colOf.has(key)) {
      this.colOf.set(key, this.cols.length);
      this.cols.push({ key, label, kind });
    }
    return this.colOf.get(key);
  }

  colFor(s, member) {
    const m = member || s.member;
    if (m) return this.col('T:' + m.type.id, m.type.n, m.type.k);
    const owner = (s.c || '').split('.')[0] || 'outside';
    return this.col('X:' + owner, owner, 'outside');
  }

  touch(...cols) {
    for (const f of this.open)
      for (const c of cols) {
        f.c0 = Math.min(f.c0, c);
        f.c1 = Math.max(f.c1, c);
      }
  }

  run(data) {
    const { ROW } = SequenceLayout;
    const entry = data.entry, root = data.root;
    const start = this.col('@start', entry.ui ? 'User' : 'Caller', 'actor');
    const main = this.colFor(root);
    this.arrows.push({ from: start, to: main, y: this.y, s: root, label: entry.ui || `${root.no}. ${callParts(root).name}()` });
    const y0 = this.y;
    this.y += ROW;
    this.enter(main);
    this.walk(root.s || [], main);
    this.leave(main);
    this.acts.push({ col: main, y0, y1: this.y, nest: 0 });
    this.arrows.push({ from: main, to: start, y: this.y, ret: true });
    this.y += ROW;
    return this.finish();
  }

  enter(c) { this.nest.set(c, (this.nest.get(c) || 0) + 1); }
  leave(c) { this.nest.set(c, this.nest.get(c) - 1); }

  walk(steps, cur) {
    const { ROW } = SequenceLayout;
    for (const s of steps) {
      if (s.k === 'call') {
        if (s.b && s.b.length && s.open) {
          // an interface or virtual call: one section per implementation it can land in
          const f = { kind: s.b.length > 1 ? 'alt' : 'via', cond: s.b.length > 1 ? `${CG.flowLabel(s)} goes to` : `${CG.flowLabel(s)} in ${s.b[0].c}`, y0: this.y, seps: [], c0: cur, c1: cur, s };
          this.frags.push(f);
          this.open.push(f);
          this.y += 26;
          s.b.forEach((b, i) => {
            if (i) { f.seps.push({ y: this.y, label: b.c }); this.y += 22; }
            else if (s.b.length > 1) f.first = b.c;
            this.call(s, cur, b.member, b.s);
          });
          if (s.s && s.s.length) this.walk(s.s, cur);
          this.open.pop();
          f.y1 = this.y + 4;
          this.y += 16;
        } else this.call(s, cur, null, s.open ? s.s : null);
      } else if (s.k === 'loop' || s.k === 'if' || s.k === 'switch' || s.k === 'try') {
        const kind = s.k === 'loop' ? 'loop' : s.k === 'try' ? 'try' : s.k === 'switch' ? 'alt' : s.b[1] && s.b[1].s.length ? 'alt' : 'opt';
        const f = { kind, cond: s.k === 'try' ? '' : s.c, y0: this.y, seps: [], c0: cur, c1: cur, s };
        this.frags.push(f);
        this.open.push(f);
        this.view.hits.push({ s, x: 0, y: this.y, w: 0, h: 22, frag: f });
        this.y += 26;
        if (s.k === 'loop') this.walk(s.s || [], cur);
        else {
          let shown = 0;
          for (const b of s.b) {
            if (kind === 'opt' && !b.s.length) continue;
            if (shown++) { f.seps.push({ y: this.y, label: b.c }); this.y += 22; }
            else f.first = s.k === 'if' ? null : b.c;
            this.walk(b.s, cur);
            if (!b.s.length) this.y += 12;
          }
        }
        this.open.pop();
        f.y1 = this.y + 4;
        this.y += 16;
      } else {
        this.notes.push({ col: cur, y: this.y, s, text: CG.flowLabel(s), nest: (this.nest.get(cur) || 1) - 1 });
        this.view.hits.push({ s, note: true, col: cur, y: this.y - 12, h: 22 });
        this.y += ROW * 0.75;
      }
    }
  }

  call(s, cur, member, body) {
    const { ROW } = SequenceLayout;
    const to = this.colFor(s, member);
    this.touch(cur, to);
    const m = member || s.member;
    const name = !m ? callParts(s).name : m.k === 'ctor' ? `new ${m.type.n}` : m.n;
    const opened = !!(body && body.length);
    const out = CG.stepOut(s);
    // what goes in; when the call is not opened, where its result goes too
    let label = `${s.no}. ${s.aw ? 'await ' : ''}${name}${m ? CG.argsText(s, 34) : ''}`;
    if (!opened && out) label += `  → ${out}`;
    const nestFrom = (this.nest.get(cur) || 1) - 1;
    const y0 = this.y;
    this.arrows.push({ from: cur, to, y: y0, s, label, nestFrom, nestTo: this.nest.get(to) || 0, outside: !s.member && !member, stop: s.x });
    this.y += ROW;
    if (opened) {
      const nest = this.nest.get(to) || 0;
      this.enter(to);
      this.walk(body, to);
      this.leave(to);
      this.acts.push({ col: to, y0, y1: this.y, nest });
      // a call within the same class returns along its own activation bar, not with a second arrow
      if (to !== cur) {
        this.arrows.push({ from: to, to: cur, y: this.y, ret: true, s, label: out, nestFrom: nest, nestTo: nestFrom });
        this.y += ROW * 0.75;
      } else this.y += ROW * 0.3;
    } else {
      this.acts.push({ col: to, y0, y1: y0 + ROW * 0.5, nest: this.nest.get(to) || 0 });
    }
  }

  finish() {
    const ctx = this.ctx;
    ctx.font = '600 12px Inter';
    const widest = Math.max(...this.cols.map((c) => ctx.measureText(c.label).width));
    ctx.font = '12px Inter';
    const widestLabel = Math.max(0, ...this.arrows.filter((a) => a.label && Math.abs(a.to - a.from) === 1).map((a) => ctx.measureText(a.label).width));
    // wide enough for the labels between neighbours, but long labels may overrun rather than spread every column
    this.COL = Math.max(170, widest + 50, Math.min(widestLabel + 40, 380));
    const X = (c) => c * this.COL;
    this.X = X;
    // hit boxes for arrows and notes, now that columns have places
    for (const a of this.arrows) {
      if (!a.s || a.ret) continue;
      const x0 = Math.min(X(a.from), X(a.to)), x1 = Math.max(X(a.from), X(a.to));
      this.view.hits.push({ s: a.s, x: a.from === a.to ? X(a.from) : x0, y: a.y - 14, w: a.from === a.to ? 60 : Math.max(30, x1 - x0), h: a.from === a.to ? 34 : 22 });
    }
    for (const h of this.view.hits) {
      if (h.note) { h.x = X(h.col) + 8; h.w = 200; }
      if (h.frag) { h.x = X(h.frag.c0) - this.COL * 0.45; h.w = 120; }
    }
    this.view.hits = this.view.hits.filter((h) => h.w > 0);
    const b = { x0: -this.COL * 0.5, y0: -80, x1: X(this.cols.length - 1) + this.COL * 0.5, y1: this.y + 20 };
    return { bounds: b, draw: (c, t, cam) => this.draw(c, t, cam) };
  }

  draw(ctx, t) {
    const { ROW } = SequenceLayout;
    const X = this.X, a = this.app, sel = a.fsel, hov = a.hover, COL = this.COL, end = this.y;

    // fragments: alt, opt, loop, try
    for (const f of this.frags) {
      // a box around one lifeline still needs room for its condition
      const x0 = X(f.c0) - COL * 0.45, x1 = Math.max(X(f.c1) + COL * 0.45, X(f.c0) + COL * 1.2);
      ctx.beginPath();
      ctx.roundRect(x0, f.y0, x1 - x0, f.y1 - f.y0, 6);
      ctx.fillStyle = t.hoverSoft;
      ctx.fill();
      ctx.lineWidth = f.s === sel ? 2 : 1;
      ctx.strokeStyle = f.s === sel ? t.accent : t.edgeSoft;
      ctx.stroke();
      for (const sp of f.seps) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = t.edgeSoft;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, sp.y);
        ctx.lineTo(x1, sp.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      f.x0 = x0;
      f.x1 = x1;
    }

    // lifelines and headers
    this.cols.forEach((c, i) => {
      const x = X(i);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = t.edgeSoft;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, -30);
      ctx.lineTo(x, end);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '600 12px Inter';
      const w = Math.min(COL - 16, ctx.measureText(c.label).width + 28);
      if (c.kind === 'actor') {
        ctx.strokeStyle = t.text;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, -66, 6, 0, Math.PI * 2);
        ctx.moveTo(x, -60); ctx.lineTo(x, -46);
        ctx.moveTo(x - 8, -55); ctx.lineTo(x + 8, -55);
        ctx.moveTo(x, -46); ctx.lineTo(x - 7, -37);
        ctx.moveTo(x, -46); ctx.lineTo(x + 7, -37);
        ctx.stroke();
        ctx.fillStyle = t.text;
        ctx.textAlign = 'center';
        ctx.fillText(c.label, x, -22);
        ctx.textAlign = 'left';
        return;
      }
      ctx.beginPath();
      ctx.roundRect(x - w / 2, -66, w, 34, 8);
      ctx.fillStyle = t.card;
      ctx.fill();
      ctx.strokeStyle = t.cardStroke;
      ctx.stroke();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = c.kind === 'outside' ? t.text2 : CG.kindColor(c.kind);
      ctx.fillRect(x - w / 2, -66, w, 3);
      ctx.restore();
      ctx.fillStyle = c.kind === 'outside' ? t.text2 : t.text;
      ctx.textAlign = 'center';
      ctx.fillText(CG.fit(ctx, c.label, w - 16), x, -44);
      ctx.textAlign = 'left';
    });

    // activations
    for (const act of this.acts) {
      const x = X(act.col) - 5 + act.nest * 6;
      ctx.beginPath();
      ctx.roundRect(x, act.y0, 10, Math.max(8, act.y1 - act.y0), 3);
      ctx.fillStyle = t.card;
      ctx.fill();
      ctx.strokeStyle = t.cardStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // calls and returns
    const trace = a.trace;
    for (const ar of this.arrows) {
      const role = trace && ar.s && trace.roles.get(ar.s);
      const traced = role && (!ar.ret || role === 'gives it back' || role === 'makes it');
      const hot = traced || (ar.s && (ar.s === sel || ar.s === hov));
      ctx.globalAlpha = trace && !traced && ar.s !== sel ? 0.3 : 1;
      ctx.strokeStyle = hot ? t.accent : ar.ret ? t.edgeSoft : t.edge;
      ctx.lineWidth = hot ? 1.8 : 1.2;
      const fx = X(ar.from) + 5 + (ar.nestFrom || 0) * 6, tx = X(ar.to) - 5 + (ar.nestTo || 0) * 6;
      if (ar.from === ar.to) {
        // a call to a method of the same class
        const x = X(ar.from) + 5 + (ar.nestFrom || 0) * 6;
        ctx.beginPath();
        ctx.moveTo(x, ar.y);
        ctx.lineTo(x + 34, ar.y);
        ctx.lineTo(x + 34, ar.y + 14);
        ctx.lineTo(x + 8, ar.y + 14);
        ctx.stroke();
        CG.arrow(ctx, x + 7, ar.y + 14, Math.PI, 7, false);
        if (ar.label) this.label(ctx, t, ar, x + 40, ar.y + 4, 'left');
        if (traced) this.roleTag(ctx, t, role, x - 110, ar.y + 7);
        continue;
      }
      const dir = Math.sign(X(ar.to) - X(ar.from));
      const x0 = dir > 0 ? fx : X(ar.from) - 5 + (ar.nestFrom || 0) * 6;
      const x1 = dir > 0 ? tx : X(ar.to) + 5 + (ar.nestTo || 0) * 6;
      ctx.setLineDash(ar.ret ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x0, ar.y);
      ctx.lineTo(x1, ar.y);
      ctx.stroke();
      ctx.setLineDash([]);
      CG.arrow(ctx, x1, ar.y, dir > 0 ? 0 : Math.PI, 8, false);
      if (ar.label) this.label(ctx, t, ar, (x0 + x1) / 2, ar.y - 6, 'center');
      if (traced && !ar.ret) this.roleTag(ctx, t, role, Math.max(x0, x1) + 14, ar.y);
    }
    ctx.globalAlpha = 1;

    // returns and throws inside a method
    for (const n of this.notes) {
      const x = X(n.col) + 10 + n.nest * 6;
      ctx.font = '500 11.5px Inter';
      ctx.fillStyle = n.s.k === 'throw' ? t.danger : t.text2;
      if (n.s === sel) ctx.fillStyle = t.accent;
      ctx.fillText(CG.fit(ctx, (n.s.k === 'throw' ? '⚠ ' : '↩ ') + n.text, COL * 0.9), x, n.y + 4);
    }

    // fragment tags and conditions last, on a backing, so lifelines and activations do not run through them
    for (const f of this.frags) {
      const x0 = f.x0, x1 = f.x1;
      ctx.font = '700 11px Inter';
      const tag = f.kind === 'via' ? 'call' : f.kind;
      const tw = ctx.measureText(tag).width + 14;
      ctx.beginPath();
      ctx.moveTo(x0, f.y0 + 6);
      ctx.arcTo(x0, f.y0, x0 + 6, f.y0, 6);
      ctx.lineTo(x0 + tw, f.y0);
      ctx.lineTo(x0 + tw, f.y0 + 12);
      ctx.lineTo(x0 + tw - 6, f.y0 + 18);
      ctx.lineTo(x0, f.y0 + 18);
      ctx.closePath();
      ctx.fillStyle = t.labelBg;
      ctx.fill();
      ctx.fillStyle = t.text;
      ctx.fillText(tag, x0 + 6, f.y0 + 13);
      ctx.font = '11.5px Inter';
      const cond = f.cond ? `[${f.cond}]` : '';
      if (cond) {
        const text = CG.fit(ctx, cond + (f.first ? `  ${f.first}` : ''), x1 - x0 - tw - 16);
        ctx.fillStyle = t.card;
        ctx.fillRect(x0 + tw + 4, f.y0 + 2, ctx.measureText(text).width + 8, 15);
        ctx.fillStyle = t.text2;
        ctx.fillText(text, x0 + tw + 8, f.y0 + 13);
      }
      for (const sp of f.seps) {
        const text = `[${sp.label}]`;
        ctx.fillStyle = t.card;
        ctx.fillRect(x0 + 4, sp.y + 3, ctx.measureText(text).width + 8, 15);
        ctx.fillStyle = t.text2;
        ctx.fillText(text, x0 + 8, sp.y + 14);
      }
    }
    void ROW;
  }

  /** What an arrow's step does with the followed value. */
  roleTag(ctx, t, role, x, y) {
    ctx.font = '600 11px Inter';
    const w = ctx.measureText(role).width + 14;
    ctx.beginPath();
    ctx.roundRect(x, y - 9, w, 18, 9);
    ctx.fillStyle = t.accent;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(role, x + 7, y + 4);
  }

  label(ctx, t, ar, x, y, align) {
    if (ar.ret) {
      // what comes back, on the dashed return arrow
      ctx.font = 'italic 11.5px Inter';
      ctx.fillStyle = t.accentText;
      ctx.textAlign = align;
      ctx.fillText(ar.label, x, y);
      ctx.textAlign = 'left';
      return;
    }
    ctx.font = ar.outside ? 'italic 12px Inter' : '500 12px Inter';
    ctx.fillStyle = ar.s === this.app.fsel ? t.accentText : ar.outside ? t.text2 : t.text;
    ctx.textAlign = align;
    let text = ar.label;
    if (ar.stop) text += `  · ${STOP_TEXT[ar.stop]}`;
    if (CG.canOpen(ar.s) && !ar.s.open) text += '  ▸';
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
  }
}
