'use strict';
// Calls view: one method in the middle, the methods that call it to the left and the methods it calls to the
// right, as many steps out as the Depth setting. Calls between any two methods on screen are drawn.

CG.CallView = class {
  static COL = 330;
  static ROW = 34;
  static H = 24;
  /** More methods than this in one column are summed up in one "N more" item. */
  static MAX_PER_LEVEL = 40;

  constructor(app) {
    this.app = app;
    this.cam = new CG.Camera();
    this.items = [];
    this.byMember = new Map();
    this.edges = [];
    this.levels = new Map();
    this.key = '';
    this.fitPending = true;
  }

  width(ctx, x, focus) {
    ctx.font = '11.5px Inter';
    const type = Math.min(ctx.measureText(x.type.n + '.').width, 140);
    ctx.font = `${focus ? 600 : 500} 12px Inter`;
    const name = Math.min(ctx.measureText(x.k === 'ctor' ? 'new' : x.n).width, 170);
    return Math.ceil(26 + type + name + 12);
  }

  layout(ctx) {
    const a = this.app, f = a.callFocus, { COL, ROW, MAX_PER_LEVEL } = CG.CallView;
    const key = [a.codeVersion, f && f.id, a.depth, a.impact && a.impact.target.id].join('|');
    if (key === this.key) return;
    this.key = key;
    this.fitPending = true;
    this.items = [];
    this.edges = [];
    this.byMember.clear();
    if (a.impact) return this.layoutImpact(ctx, a.impact);
    if (!f) return;

    // walk out from the focus both ways, one column per step
    const level = new Map([[f, 0]]);
    const columns = new Map([[0, [f]]]);
    const more = new Map();
    for (const dir of [1, -1]) {
      let frontier = [f];
      for (let d = 1; d <= a.depth && frontier.length; d++) {
        const next = [];
        const weight = new Map();
        for (const n of frontier)
          for (const [m, count] of dir > 0 ? n.out : n.in) {
            if (level.has(m) && level.get(m) !== d * dir) continue;
            weight.set(m, (weight.get(m) || 0) + count);
          }
        const ranked = [...weight.keys()].sort((p, q) => weight.get(q) - weight.get(p));
        for (const m of ranked.slice(0, MAX_PER_LEVEL)) {
          level.set(m, d * dir);
          next.push(m);
        }
        if (ranked.length > MAX_PER_LEVEL) more.set(d * dir, ranked.length - MAX_PER_LEVEL);
        if (next.length) columns.set(d * dir, next);
        frontier = next;
      }
    }

    // order: the first steps by name, later steps by where their neighbours one step in are
    const pos = new Map([[f, 0]]);
    const byName = (p, q) => p.label.localeCompare(q.label);
    for (const dir of [1, -1])
      for (let d = 1; columns.has(d * dir); d++) {
        const col = columns.get(d * dir);
        if (d === 1) col.sort(byName);
        else {
          const inner = (m) => [...(dir > 0 ? m.in : m.out).keys()].filter((n) => level.get(n) === (d - 1) * dir);
          const bary = (m) => {
            const near = inner(m);
            return near.length ? near.reduce((s, n) => s + pos.get(n), 0) / near.length : 0;
          };
          col.sort((p, q) => bary(p) - bary(q) || byName(p, q));
        }
        col.forEach((m, i) => pos.set(m, i));
      }

    for (const [lv, col] of columns) {
      const count = col.length + (more.has(lv) ? 1 : 0);
      col.forEach((m, i) => {
        const w = this.width(ctx, m, m === f);
        const it = { member: m, level: lv, w, x: lv * COL - w / 2, y: (i - (count - 1) / 2) * ROW };
        this.items.push(it);
        this.byMember.set(m, it);
      });
      if (more.has(lv)) this.items.push({ more: more.get(lv), level: lv, w: 110, x: lv * COL - 55, y: (count - 1 - (count - 1) / 2) * ROW });
    }
    this.levels = columns;

    for (const it of this.items) {
      if (it.more) continue;
      for (const [callee, count] of it.member.out) {
        const to = this.byMember.get(callee);
        if (to) this.edges.push({ from: it, to, count });
      }
    }
  }

  /**
   * Impact: the changed member (or a type's members) on the right, and to the left, one column per step, every
   * member that calls or uses it, up to where flows start. Starting points are labelled with their control.
   */
  layoutImpact(ctx, impact) {
    const { COL, ROW, MAX_PER_LEVEL } = CG.CallView;
    const columns = new Map();
    for (const [m, d] of impact.reached) {
      if (!columns.has(-d)) columns.set(-d, []);
      columns.get(-d).push(m);
    }
    const more = new Map();
    for (const [lv, col] of columns) {
      col.sort((p, q) => (q.ep ? 1 : 0) - (p.ep ? 1 : 0) || p.label.localeCompare(q.label));
      if (col.length > MAX_PER_LEVEL) {
        more.set(lv, col.length - MAX_PER_LEVEL);
        col.length = MAX_PER_LEVEL;
      }
    }
    for (const [lv, col] of columns) {
      const count = col.length + (more.has(lv) ? 1 : 0);
      col.forEach((m, i) => {
        const w = this.width(ctx, m, lv === 0);
        const it = { member: m, level: lv, w, x: lv * COL - w / 2, y: (i - (count - 1) / 2) * ROW, entry: !!m.ep };
        this.items.push(it);
        this.byMember.set(m, it);
      });
      if (more.has(lv)) this.items.push({ more: more.get(lv), level: lv, w: 110, x: lv * COL - 55, y: (count - 1 - (count - 1) / 2) * ROW });
    }
    this.levels = columns;
    // an edge from each member to what it calls, uses, or reaches through an interface, when both are shown
    for (const it of this.items) {
      if (it.more) continue;
      const m = it.member, targets = new Set([...m.out.keys(), ...m.refOut.keys()]);
      for (const t of [...targets]) for (const impl of t.implementedBy) targets.add(impl);
      for (const t of targets) {
        const to = this.byMember.get(t);
        if (to && to.level > it.level) this.edges.push({ from: it, to, count: m.out.get(t) || 1 });
      }
    }
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of this.items) {
      x0 = Math.min(x0, it.x); x1 = Math.max(x1, it.x + it.w);
      y0 = Math.min(y0, it.y - 40); y1 = Math.max(y1, it.y + 20);
    }
    return { x0, y0, x1, y1 };
  }

  fit(ctx) {
    this.layout(ctx);
    if (this.items.length) this.cam.fit(this.bounds(), this.app.region, 1.15);
  }

  reveal(ctx, m) {
    this.layout(ctx);
    const it = m && this.byMember.get(m);
    if (it && !this.cam.shows(it.x, it.y - 12, it.w, 24, this.app.region)) this.cam.center(it.x + it.w / 2, it.y, this.app.region);
  }

  pan(dx, dy) { this.cam.pan(dx, dy); }
  zoom(x, y, f) { this.cam.zoom(x, y, f); }

  draw(ctx, t) {
    this.layout(ctx);
    if (this.fitPending) { this.fit(ctx); this.fitPending = false; }
    const a = this.app, q = a.codeMatches, H = CG.CallView.H, r = a.region;
    const impact = a.impact, f = impact ? null : a.callFocus;
    if (!f && !impact) {
      ctx.fillStyle = t.text2;
      ctx.font = '13px Inter';
      ctx.textAlign = 'center';
      ctx.fillText('Pick a method in the Methods panel.', r.x + r.w / 2, r.y + r.h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const sel = a.csel && a.csel.ck === 'member' ? a.csel : null;
    ctx.save();
    this.cam.apply(ctx);

    // column titles
    const top = Math.min(...this.items.map((it) => it.y)) - 34;
    ctx.font = '600 11.5px Inter';
    ctx.fillStyle = t.text2;
    ctx.textAlign = 'center';
    for (const lv of this.levels.keys()) {
      const steps = Math.abs(lv);
      if (impact) {
        ctx.fillText(lv === 0 ? 'If this changes' : `Affected · ${CG.plural(steps, 'step')} away`, lv * CG.CallView.COL, top);
        continue;
      }
      if (!lv) continue;
      const label = (lv < 0 ? 'Called by' : 'Calls') + (steps > 1 ? ` · ${steps} steps` : '');
      ctx.fillText(label, lv * CG.CallView.COL, top);
    }
    ctx.textAlign = 'left';

    // calls
    for (const e of this.edges) {
      const hot = sel && (e.from.member === sel || e.to.member === sel);
      ctx.strokeStyle = hot ? t.accent : t.edge;
      ctx.lineWidth = Math.min(3, 1 + Math.log2(e.count) * 0.6) * (hot ? 1.3 : 1);
      ctx.beginPath();
      let ex, ey, angle;
      if (e.from === e.to) {
        // recursion: a small loop on the right
        const x = e.from.x + e.from.w, y = e.from.y;
        ctx.moveTo(x, y - 5);
        ctx.bezierCurveTo(x + 26, y - 22, x + 26, y + 22, x + 2, y + 6);
        ex = x + 1; ey = y + 6; angle = Math.PI * 0.85;
      } else if (e.from.x + e.from.w < e.to.x) {
        const x0 = e.from.x + e.from.w, x1 = e.to.x, mx = (x0 + x1) / 2;
        ctx.moveTo(x0, e.from.y);
        ctx.bezierCurveTo(mx, e.from.y, mx, e.to.y, x1, e.to.y);
        ex = x1; ey = e.to.y; angle = 0;
      } else {
        // a call back towards the left, or within one column: arc above
        const x0 = e.from.x + e.from.w / 2, x1 = e.to.x + e.to.w / 2, lift = 30 + Math.abs(x1 - x0) * 0.15;
        const y0 = e.from.y - H / 2, y1 = e.to.y - H / 2;
        ctx.moveTo(x0, y0);
        ctx.bezierCurveTo(x0, Math.min(y0, y1) - lift, x1, Math.min(y0, y1) - lift, x1, y1);
        ex = x1; ey = y1; angle = Math.PI / 2;
      }
      ctx.stroke();
      CG.arrow(ctx, ex, ey, angle, 7, false);
    }

    // methods
    const text = this.cam.k > 0.3;
    for (const it of this.items) {
      const top = it.y - H / 2;
      if (it.more) {
        if (text) {
          ctx.font = '12px Inter';
          ctx.fillStyle = t.text2;
          ctx.fillText(`${it.more} more`, it.x + 10, it.y + 4);
        }
        continue;
      }
      const m = it.member, isFocus = impact ? it.level === 0 : m === f, isSel = m === sel, hov = m === a.hover;
      ctx.globalAlpha = q && !q.has(m.id) ? 0.3 : 1;
      ctx.beginPath();
      ctx.roundRect(it.x, top, it.w, H, 8);
      ctx.fillStyle = isFocus ? t.accentSoft : hov ? t.cardHover : t.card;
      ctx.fill();
      ctx.lineWidth = isSel || isFocus ? 2 : 1;
      ctx.strokeStyle = isSel ? t.accent : isFocus ? t.accent : t.cardStroke;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(it.x + 13, it.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = CG.kindColor(m.type.k);
      ctx.fill();
      if (text) {
        ctx.font = '11.5px Inter';
        ctx.fillStyle = t.text2;
        const typeText = CG.fit(ctx, m.type.n + '.', 140);
        ctx.fillText(typeText, it.x + 23, it.y + 4);
        const tw = ctx.measureText(typeText).width;
        ctx.font = `${m.abs ? 'italic ' : ''}${isFocus ? 600 : 500} 12px Inter`;
        ctx.fillStyle = t.text;
        ctx.fillText(CG.fit(ctx, m.k === 'ctor' ? 'new' : m.n, 170), it.x + 23 + tw, it.y + 4);
      }
      // where a flow starts: name the control or kind, so the reach of a change reads as "this button"
      if (impact && it.entry && text) {
        const label = m.ui || { event: 'event', command: 'command', action: 'web API', main: 'program start', test: 'test' }[m.ep] || 'start';
        ctx.font = '600 11px Inter';
        const w = Math.min(220, ctx.measureText(label).width + 14);
        ctx.beginPath();
        ctx.roundRect(it.x - w - 8, it.y - 9, w, 18, 9);
        ctx.fillStyle = t.accent;
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(CG.fit(ctx, label, w - 14), it.x - w + 1, it.y + 4);
      }
      ctx.globalAlpha = 1;
    }

    if (this.items.length === (impact ? impact.start.length : 1)) {
      ctx.font = '12px Inter';
      ctx.fillStyle = t.text2;
      ctx.textAlign = 'center';
      ctx.fillText(impact ? "Nothing in the solution's code uses this, so a change reaches nothing else." : "Nothing in the solution's code calls this or is called by it.", 0, 40);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  hit(sx, sy) {
    const [x, y] = this.cam.toWorld(sx, sy), H = CG.CallView.H;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!it.more && x >= it.x && x <= it.x + it.w && y >= it.y - H / 2 && y <= it.y + H / 2) return it.member;
    }
    return null;
  }
};
