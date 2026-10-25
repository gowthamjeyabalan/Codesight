'use strict';
// Classes view: a UML class diagram of the types in scope (a namespace, a type and its relations, or the types in
// a file or folder). Inheritance is laid out in layers, bases above; the other types sit in rows below.
// Arrows: hollow triangle = inherits, dashed with hollow triangle = implements, thin = has a field or property of.

CG.ClassView = class {
  static GAP_X = 36;
  static GAP_Y = 86;
  static LINE = 18;
  static MAX_LINES = 14;
  static MAX_TYPES = 80;

  constructor(app) {
    this.app = app;
    this.cam = new CG.Camera();
    this.boxes = [];
    this.byId = new Map();
    this.hier = [];
    this.uses = [];
    this.key = '';
    this.fitPending = true;
    this.total = 0;
  }

  /** The scope's types, plus the bases and interfaces outside it (shown faded for context). */
  entries() {
    const a = this.app, c = a.code, s = a.scope, { MAX_TYPES } = CG.ClassView;
    if (!c || !s) return [];
    const get = (id) => (id == null ? null : c.byId.get(id));
    let main = [];
    if (s.kind === 'ns') main = s.ns.types;
    else if (s.kind === 'files') main = s.types;
    else if (s.kind === 'type') {
      const t = s.type, set = new Set([t]);
      for (let p = get(t.b); p && !set.has(p); p = get(p.b)) set.add(p);
      for (const x of [...t.i.map(get), ...t.derived, ...t.implementors, ...t.u.map(get), ...t.usedBy]) if (x) set.add(x);
      main = [...set];
    }
    this.total = main.length;
    if (main.length > MAX_TYPES) {
      const degree = (t) => t.derived.length + t.implementors.length + t.usedBy.length + t.u.length + t.i.length + (t.b != null ? 1 : 0);
      main = main.slice().sort((p, q) => degree(q) - degree(p)).slice(0, MAX_TYPES);
    }
    const inMain = new Set(main), ghosts = new Set();
    for (const t of main)
      for (const id of [t.b, ...t.i]) {
        const p = get(id);
        if (p && !inMain.has(p)) ghosts.add(p);
      }
    return [...main.map((t) => ({ t, ghost: false })), ...[...ghosts].map((t) => ({ t, ghost: true }))];
  }

  static stereotype(t) {
    if (t.k === 'class') return t.mod === 'abstract' || t.mod === 'static' ? `«${t.mod}»` : null;
    return `«${t.k === 'enum' ? 'enumeration' : t.k}»`;
  }

  static lineText(x) {
    return x.n + (x.k === 'value' ? '' : x.s);
  }

  /** Member lines for the box, by the Members setting; long lists end in "N more". */
  lines(t) {
    const mode = this.app.membersMode, { MAX_LINES } = CG.ClassView;
    if (mode === 'none') return { list: [], more: 0 };
    const order = { value: 0, field: 1, prop: 2, event: 3, ctor: 4, method: 5, operator: 6 };
    let list = t.m.filter((x) => mode === 'all' || x.a === 'public' || x.a.startsWith('protected'));
    list = list.slice().sort((p, q) => order[p.k] - order[q.k]);
    if (list.length <= MAX_LINES) return { list, more: 0 };
    return { list: list.slice(0, MAX_LINES - 1), more: list.length - (MAX_LINES - 1) };
  }

  measure(ctx, { t, ghost }) {
    const { LINE } = CG.ClassView;
    const stereo = CG.ClassView.stereotype(t);
    const { list, more } = this.lines(t);
    ctx.font = '600 12.5px Inter';
    let w = ctx.measureText(t.n).width;
    if (stereo) {
      ctx.font = '11px Inter';
      w = Math.max(w, ctx.measureText(stereo).width);
    }
    ctx.font = '12px Inter';
    // room for the line's text and its badge (complexity or "unused")
    for (const x of list) w = Math.max(w, ctx.measureText(CG.ClassView.lineText(x)).width + 16 + (x.unused ? 50 : x.cx >= 6 ? 26 : 0));
    w = Math.min(320, Math.max(150, Math.ceil(w + 28)));
    const headerH = stereo ? 46 : 34;
    const rows = list.length + (more ? 1 : 0);
    return { t, ghost, stereo, list, more, w, headerH, h: headerH + (rows ? rows * LINE + 12 : 0), x: 0, y: 0 };
  }

  layout(ctx) {
    const a = this.app, s = a.scope, { GAP_X, GAP_Y } = CG.ClassView;
    const key = [a.codeVersion, s && s.key, a.membersMode].join('|');
    if (key === this.key) return;
    this.key = key;
    this.fitPending = true;
    const boxes = (this.boxes = this.entries().map((e) => this.measure(ctx, e)));
    const byId = (this.byId = new Map(boxes.map((b) => [b.t.id, b])));

    // inheritance and implementation, child -> parent
    this.hier = [];
    const parents = new Map(), children = new Map();
    for (const b of boxes) {
      parents.set(b, []);
      children.set(b, []);
    }
    for (const b of boxes) {
      const link = (id, kind) => {
        const p = byId.get(id);
        if (!p || p === b) return;
        this.hier.push({ from: b, to: p, kind });
        parents.get(b).push(p);
        children.get(p).push(b);
      };
      if (b.t.b != null) link(b.t.b, 'inherit');
      for (const i of b.t.i) link(i, 'implement');
    }
    const inHier = boxes.filter((b) => parents.get(b).length || children.get(b).length);

    // layers: bases on top, each type one layer below its lowest parent
    const rank = new Map();
    const rankOf = (b, guard = 0) => {
      if (rank.has(b)) return rank.get(b);
      let r = 0;
      if (guard < 64) for (const p of parents.get(b)) r = Math.max(r, rankOf(p, guard + 1) + 1);
      rank.set(b, r);
      return r;
    };
    const layers = [];
    for (const b of inHier.sort((p, q) => p.t.n.localeCompare(q.t.n))) (layers[rankOf(b)] = layers[rankOf(b)] || []).push(b);
    for (let i = 0; i < layers.length; i++) layers[i] = layers[i] || [];

    // order each layer by the mean position of its neighbours, sweeping down and up a few times
    const pos = new Map();
    const index = () => layers.forEach((l) => l.forEach((b, i) => pos.set(b, i)));
    const bary = (b, near) => (near.length ? near.reduce((s, n) => s + pos.get(n), 0) / near.length : pos.get(b));
    index();
    for (let pass = 0; pass < 4; pass++) {
      for (let r = 1; r < layers.length; r++) {
        layers[r].sort((p, q) => bary(p, parents.get(p)) - bary(q, parents.get(q)));
        index();
      }
      for (let r = layers.length - 2; r >= 0; r--) {
        layers[r].sort((p, q) => bary(p, children.get(p)) - bary(q, children.get(q)));
        index();
      }
    }

    let y = 0, widest = 0;
    for (const layer of layers) {
      if (!layer.length) continue;
      const width = layer.reduce((s, b) => s + b.w, 0) + GAP_X * (layer.length - 1);
      widest = Math.max(widest, width);
      let x = -width / 2, tall = 0;
      for (const b of layer) {
        b.x = x;
        b.y = y;
        x += b.w + GAP_X;
        tall = Math.max(tall, b.h);
      }
      y += tall + GAP_Y;
    }

    // the rest in rows, types that use each other kept together
    const inSet = new Set(inHier);
    const rest = boxes.filter((b) => !inSet.has(b));
    if (rest.length) {
      const restSet = new Set(rest), seen = new Set(), ordered = [];
      const near = (b) => [...b.t.u, ...b.t.usedBy.map((t) => t.id)].map((id) => byId.get(id)).filter((n) => n && restSet.has(n));
      const degree = (b) => near(b).length;
      for (const start of rest.slice().sort((p, q) => degree(q) - degree(p) || p.t.n.localeCompare(q.t.n))) {
        if (seen.has(start)) continue;
        const queue = [start];
        seen.add(start);
        while (queue.length) {
          const b = queue.shift();
          ordered.push(b);
          for (const n of near(b)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
        }
      }
      const area = ordered.reduce((s, b) => s + (b.w + GAP_X) * (b.h + 40), 0);
      const target = Math.max(widest, Math.sqrt(area) * 1.6, 560);
      let row = [], rowW = 0;
      const flush = () => {
        let x = -rowW / 2, tall = 0;
        for (const b of row) {
          b.x = x;
          b.y = y;
          x += b.w + GAP_X;
          tall = Math.max(tall, b.h);
        }
        y += tall + 40;
        row = [];
        rowW = 0;
      };
      for (const b of ordered) {
        if (row.length && rowW + GAP_X + b.w > target) flush();
        rowW += (row.length ? GAP_X : 0) + b.w;
        row.push(b);
      }
      if (row.length) flush();
    }

    this.uses = [];
    for (const b of boxes)
      for (const id of b.t.u) {
        const target = byId.get(id);
        if (target && target !== b) this.uses.push({ from: b, to: target });
      }
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of this.boxes) {
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return { x0, y0, x1, y1 };
  }

  fit(ctx) {
    this.layout(ctx);
    if (this.boxes.length) this.cam.fit(this.bounds(), this.app.region, 1);
  }

  reveal(ctx, x) {
    this.layout(ctx);
    const b = x && this.byId.get(x.ck === 'member' ? x.type.id : x.id);
    if (b && !this.cam.shows(b.x, b.y, b.w, Math.min(b.h, 300), this.app.region)) this.cam.center(b.x + b.w / 2, b.y + Math.min(b.h, 300) / 2, this.app.region);
  }

  pan(dx, dy) { this.cam.pan(dx, dy); }
  zoom(x, y, f) { this.cam.zoom(x, y, f); }

  /** Where the line from the centre of `b` towards (x, y) leaves the box. */
  static border(b, x, y) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = x - cx, dy = y - cy;
    if (!dx && !dy) return [cx, cy];
    const s = Math.min(dx ? Math.abs(b.w / 2 / dx) : Infinity, dy ? Math.abs(b.h / 2 / dy) : Infinity);
    return [cx + dx * s, cy + dy * s];
  }

  draw(ctx, t) {
    this.layout(ctx);
    if (this.fitPending) { this.fit(ctx); this.fitPending = false; }
    const a = this.app, q = a.codeMatches, { LINE } = CG.ClassView;
    if (!this.boxes.length) {
      const r = a.region;
      ctx.fillStyle = t.text2;
      ctx.font = '13px Inter';
      ctx.textAlign = 'center';
      ctx.fillText(a.scope ? 'No types here.' : 'Pick a namespace or a type in the Types panel.', r.x + r.w / 2, r.y + r.h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const sel = a.csel && (a.csel.ck === 'type' ? a.csel : a.csel.ck === 'member' ? a.csel.type : null);
    const v = this.cam.visible();
    ctx.save();
    this.cam.apply(ctx);

    // associations
    for (const e of this.uses) {
      const hot = sel && (e.from.t === sel || e.to.t === sel);
      const [x0, y0] = CG.ClassView.border(e.from, e.to.x + e.to.w / 2, e.to.y + e.to.h / 2);
      const [x1, y1] = CG.ClassView.border(e.to, e.from.x + e.from.w / 2, e.from.y + e.from.h / 2);
      ctx.strokeStyle = hot ? t.accent : t.edgeSoft;
      ctx.lineWidth = hot ? 1.6 : 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      CG.arrow(ctx, x1, y1, Math.atan2(y1 - y0, x1 - x0), 8, false);
    }

    // inheritance: children share a bus line under their parent
    for (const e of this.hier) {
      const c = e.from, p = e.to, hot = sel && (c.t === sel || p.t === sel);
      const cx = c.x + c.w / 2, px = p.x + p.w / 2, pb = p.y + p.h;
      const bus = pb + 24 + (e.kind === 'implement' ? 10 : 0);
      ctx.strokeStyle = hot ? t.accent : t.edge;
      ctx.lineWidth = hot ? 1.8 : 1.2;
      ctx.setLineDash(e.kind === 'implement' ? [5, 4] : []);
      ctx.beginPath();
      if (c.y > pb) {
        ctx.moveTo(cx, c.y);
        ctx.lineTo(cx, bus);
        ctx.lineTo(px, bus);
        ctx.lineTo(px, pb + 10);
      } else {
        // a parent that ended up level with or below its child (outside bases): a plain curve
        const [x0, y0] = CG.ClassView.border(c, px, p.y + p.h / 2);
        ctx.moveTo(x0, y0);
        ctx.lineTo(px, pb + 10);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      CG.arrow(ctx, px, pb, -Math.PI / 2, 11, true, t.card);
    }

    // boxes
    const detail = this.cam.k > 0.3;
    for (const b of this.boxes) {
      if (b.x > v.x1 || b.x + b.w < v.x0 || b.y > v.y1 || b.y + b.h < v.y0) continue;
      const ty = b.t, isSel = ty === sel, hov = a.hover === ty || (a.hover && a.hover.type === ty);
      ctx.globalAlpha = b.ghost ? 0.45 : q && !q.has(ty.id) ? 0.3 : 1;
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 9);
      ctx.fillStyle = t.card;
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = CG.kindColor(ty.k);
      ctx.fillRect(b.x, b.y, b.w, 4);
      ctx.restore();
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeStyle = isSel ? t.accent : hov ? t.text2 : t.cardStroke;
      // a type with no use found gets a dashed outline and says so
      if (ty.unused) ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (ty.unused) {
        ctx.font = '10.5px Inter';
        ctx.fillStyle = t.warn;
        ctx.textAlign = 'right';
        ctx.fillText('no use found', b.x + b.w - 8, b.y + 16);
      }

      ctx.textAlign = 'center';
      if (b.stereo) {
        ctx.font = '11px Inter';
        ctx.fillStyle = t.text2;
        ctx.fillText(b.stereo, b.x + b.w / 2, b.y + 20);
      }
      ctx.font = `${ty.mod === 'abstract' || ty.k === 'interface' ? 'italic ' : ''}600 12.5px Inter`;
      ctx.fillStyle = t.text;
      ctx.fillText(CG.fit(ctx, ty.n, b.w - 16), b.x + b.w / 2, b.y + (b.stereo ? 36 : 22));
      ctx.textAlign = 'left';

      if (b.list.length || b.more) {
        ctx.strokeStyle = t.cardStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y + b.headerH);
        ctx.lineTo(b.x + b.w, b.y + b.headerH);
        ctx.stroke();
        if (detail) {
          const y0 = b.y + b.headerH + 6;
          b.list.forEach((x, i) => {
            const y = y0 + i * LINE;
            if (x === a.csel || x === a.hover) {
              ctx.fillStyle = x === a.csel ? t.accentSoft : t.hoverSoft;
              ctx.fillRect(b.x + 1, y, b.w - 2, LINE);
            }
            // on the paused call stack: an accent bar at the left edge
            if (a.liveSet && a.liveSet.has(x)) {
              ctx.fillStyle = t.accent;
              ctx.fillRect(b.x + 1, y + 2, 3, LINE - 4);
            }
            const faded = q && !q.has(x.id) && !q.has(ty.id);
            ctx.globalAlpha = b.ghost ? 0.45 : faded ? 0.35 : x.unused ? 0.55 : 1;
            // on the right: "unused", or the complexity of a method worth a look
            const badge = x.unused ? 'unused' : x.cx >= 6 ? String(x.cx) : '';
            ctx.font = '600 10.5px Inter';
            const badgeW = badge ? ctx.measureText(badge).width + 12 : 0;
            if (badge) {
              ctx.beginPath();
              ctx.roundRect(b.x + b.w - badgeW - 6, y + 3, badgeW, 13, 6.5);
              ctx.fillStyle = x.unused ? t.labelBg : CG.cxColor(x.cx);
              ctx.fill();
              ctx.fillStyle = x.unused ? t.text2 : 'rgba(20,22,28,0.9)';
              ctx.fillText(badge, b.x + b.w - badgeW, y + 13);
            }
            const room = b.w - 34 - (badge ? badgeW + 6 : 0);
            ctx.font = '12px Inter';
            ctx.fillStyle = t.text2;
            ctx.fillText(CG.ACCESS[x.a] || '', b.x + 10, y + 13);
            ctx.font = `${x.abs ? 'italic ' : ''}${x.st ? '500 ' : ''}12px Inter`;
            ctx.fillStyle = t.text;
            const name = CG.fit(ctx, x.n, room);
            ctx.fillText(name, b.x + 22, y + 13);
            const nameW = ctx.measureText(name).width;
            if (name === x.n && x.s) {
              ctx.font = '12px Inter';
              ctx.fillStyle = t.text2;
              ctx.fillText(CG.fit(ctx, x.s, room + 4 - nameW), b.x + 22 + nameW, y + 13);
            }
          });
          if (b.more) {
            ctx.font = '12px Inter';
            ctx.fillStyle = t.text2;
            ctx.fillText(`${b.more} more`, b.x + 22, y0 + b.list.length * LINE + 13);
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  hit(sx, sy) {
    const [x, y] = this.cam.toWorld(sx, sy), { LINE } = CG.ClassView;
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
      const row = Math.floor((y - (b.y + b.headerH + 6)) / LINE);
      return row >= 0 && row < b.list.length && this.cam.k > 0.3 ? b.list[row] : b.t;
    }
    return null;
  }
};
