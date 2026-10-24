'use strict';
// Tree view: folders and files as a left-to-right node-link diagram. Folders open and close in place; the
// camera pans (drag) and zooms (wheel) and is shared by drawing and hit testing.

CG.TreeView = class {
  static ROW = 30;
  static COL = 250;
  static H = 22;
  /** More children than this are summed up in one "N more" item. */
  static MAX_KIDS = 150;

  constructor(app) {
    this.app = app;
    this.open = new Set(['']);
    this.cam = { x: 0, y: 0, k: 1 };
    this.items = [];
    this.byId = new Map();
    this.widths = new Map();
    this.version = 0;
    this.key = '';
    this.fitPending = true;
  }

  /** A new folder: open the root and its folders, and fit on the next draw. */
  reset(model) {
    this.open = new Set(['']);
    for (const k of model.root.kids || []) if (k.kids) this.open.add(k.path);
    this.modelChanged();
    this.fitPending = true;
  }

  modelChanged() {
    this.widths.clear();
    this.version++;
  }

  toggle(n) {
    if (!n.kids) return;
    if (this.open.has(n.path)) this.open.delete(n.path);
    else this.open.add(n.path);
    this.version++;
  }

  width(ctx, n) {
    const m = this.app.metric;
    const key = n.id + m;
    let w = this.widths.get(key);
    if (w === undefined) {
      ctx.font = '500 12px Inter';
      const name = Math.min(ctx.measureText(n.name).width, 170);
      ctx.font = '11px Inter';
      const num = ctx.measureText(CG.short(n, m)).width;
      w = Math.ceil((n.kids ? 34 : 24) + name + 10 + num + 10);
      this.widths.set(key, w);
    }
    return w;
  }

  layout(ctx) {
    const a = this.app;
    const key = [a.modelVersion, a.metric, this.version].join();
    if (key === this.key || !a.model) return;
    this.key = key;
    const { ROW, COL, MAX_KIDS } = CG.TreeView;
    const items = (this.items = []);
    this.byId.clear();
    let row = 0;
    const visit = (n, depth) => {
      const it = { node: n, x: depth * COL, y: 0, w: this.width(ctx, n), kids: [] };
      items.push(it);
      this.byId.set(n.id, it);
      if (n.kids && n.kids.length && this.open.has(n.path)) {
        const shown = n.kids.length > MAX_KIDS ? n.kids.slice(0, MAX_KIDS) : n.kids;
        for (const k of shown) it.kids.push(visit(k, depth + 1));
        if (n.kids.length > MAX_KIDS) {
          const more = { more: n.kids.length - MAX_KIDS, x: (depth + 1) * COL, y: row++ * ROW, w: 110, kids: [] };
          items.push(more);
          it.kids.push(more);
        }
        it.y = (it.kids[0].y + it.kids[it.kids.length - 1].y) / 2;
      } else it.y = row++ * ROW;
      return it;
    };
    visit(a.model.root, 0);
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const h = CG.TreeView.H;
    for (const it of this.items) {
      x0 = Math.min(x0, it.x); x1 = Math.max(x1, it.x + it.w);
      y0 = Math.min(y0, it.y - h); y1 = Math.max(y1, it.y + h);
    }
    return { x0, y0, x1, y1 };
  }

  fit(ctx) {
    this.layout(ctx);
    if (!this.items.length) return;
    const r = this.app.region, b = this.bounds();
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const k = Math.max(0.05, Math.min((r.w - 40) / bw, (r.h - 40) / bh, 1.25));
    this.cam = { k, x: r.x + (r.w - bw * k) / 2 - b.x0 * k, y: r.y + (r.h - bh * k) / 2 - b.y0 * k };
  }

  /** Opens the folders above `n` and brings it into view. */
  reveal(ctx, n) {
    let changed = false;
    for (let p = n.parent; p; p = p.parent) if (!this.open.has(p.path)) { this.open.add(p.path); changed = true; }
    if (changed) this.version++;
    this.layout(ctx);
    const it = this.byId.get(n.id);
    if (!it) return;
    const r = this.app.region, k = this.cam.k;
    const sx = it.x * k + this.cam.x, sy = it.y * k + this.cam.y;
    if (sx < r.x || sx + it.w * k > r.x + r.w || sy < r.y || sy > r.y + r.h) {
      this.cam.x = r.x + r.w / 2 - (it.x + it.w / 2) * k;
      this.cam.y = r.y + r.h / 2 - it.y * k;
    }
  }

  pan(dx, dy) {
    this.cam.x += dx;
    this.cam.y += dy;
  }

  zoom(x, y, factor) {
    const k = Math.max(0.05, Math.min(3, this.cam.k * factor));
    const f = k / this.cam.k;
    this.cam.x = x - (x - this.cam.x) * f;
    this.cam.y = y - (y - this.cam.y) * f;
    this.cam.k = k;
  }

  draw(ctx, t) {
    this.layout(ctx);
    if (this.fitPending) { this.fit(ctx); this.fitPending = false; }
    const a = this.app, q = a.matches, m = a.metric, { k, x: cx, y: cy } = this.cam, H = CG.TreeView.H;
    const vw = CG.viewport ? CG.viewport.w : innerWidth, vh = CG.viewport ? CG.viewport.h : innerHeight;
    const vx0 = -cx / k, vy0 = -cy / k, vx1 = (vw - cx) / k, vy1 = (vh - cy) / k;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(k, k);

    // edges
    ctx.strokeStyle = t.edge;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const it of this.items) {
      if (!it.kids.length) continue;
      const px = it.x + it.w;
      if (px > vx1 || it.kids[0].x < vx0) continue;
      for (const c of it.kids) {
        if (Math.max(it.y, c.y) < vy0 || Math.min(it.y, c.y) > vy1) continue;
        const mx = (px + c.x) / 2;
        ctx.moveTo(px, it.y);
        ctx.bezierCurveTo(mx, it.y, mx, c.y, c.x, c.y);
      }
    }
    ctx.stroke();

    // nodes
    const text = k > 0.32;
    for (const it of this.items) {
      if (it.x > vx1 || it.x + it.w < vx0 || it.y - H > vy1 || it.y + H < vy0) continue;
      const top = it.y - H / 2;
      if (it.more) {
        if (text) {
          ctx.font = '12px Inter';
          ctx.fillStyle = t.text2;
          ctx.fillText(`${it.more} more`, it.x + 10, it.y + 4);
        }
        continue;
      }
      const n = it.node, sel = n === a.selected, hov = n === a.hover;
      ctx.globalAlpha = q && !q.has(n.id) ? 0.3 : 1;
      ctx.beginPath();
      ctx.roundRect(it.x, top, it.w, H, 7);
      ctx.fillStyle = hov ? t.cardHover : t.card;
      ctx.fill();
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeStyle = sel ? t.accent : t.cardStroke;
      ctx.stroke();

      let x = it.x + 10;
      if (n.kids) {
        ctx.font = '9px Inter';
        ctx.fillStyle = t.text2;
        if (text) ctx.fillText(this.open.has(n.path) ? '▾' : '▸', x - 1, it.y + 3.5);
        x += 12;
      }
      ctx.beginPath();
      ctx.arc(x + 4, it.y, 4, 0, Math.PI * 2);
      if (n.kids) {
        ctx.strokeStyle = CG.langColor(CG.dominant(n));
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else {
        ctx.fillStyle = CG.fileColor(n, t);
        ctx.fill();
      }
      if (text) {
        ctx.font = '500 12px Inter';
        ctx.fillStyle = t.text;
        ctx.fillText(CG.fit(ctx, n.name, 170), x + 14, it.y + 4);
        ctx.font = '11px Inter';
        ctx.fillStyle = t.text2;
        const num = CG.short(n, m);
        ctx.fillText(num, it.x + it.w - 10 - ctx.measureText(num).width, it.y + 4);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  hit(x, y) {
    const { k, x: cx, y: cy } = this.cam, H = CG.TreeView.H;
    const wx = (x - cx) / k, wy = (y - cy) / k;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!it.more && wx >= it.x && wx <= it.x + it.w && wy >= it.y - H / 2 && wy <= it.y + H / 2) return it.node;
    }
    return null;
  }
};
