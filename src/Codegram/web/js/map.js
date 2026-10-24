'use strict';
// Map view: a nested squarified treemap. Area is the chosen measure, colour is the language, folders carry a
// header with their name while there is room for one.

/** Lays `nodes` (sorted largest first) into the rectangle as rows of near-square cells (Bruls, Huizing, van Wijk). */
function squarify(nodes, values, x, y, w, h, out) {
  let total = 0;
  for (const v of values) total += v;
  if (total <= 0 || w <= 0 || h <= 0) return;
  const scale = (w * h) / total;
  let i = 0;
  while (i < nodes.length) {
    const side = Math.min(w, h);
    let sum = 0, min = Infinity, max = 0, best = Infinity, j = i;
    while (j < nodes.length) {
      const a = values[j] * scale;
      const s = sum + a, mn = Math.min(min, a), mx = Math.max(max, a);
      const worst = Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
      if (worst > best) break;
      best = worst; sum = s; min = mn; max = mx; j++;
    }
    const thick = sum / side;
    let off = 0;
    for (let k = i; k < j; k++) {
      const len = (values[k] * scale) / thick;
      if (w >= h) out.push([nodes[k], x, y + off, thick, len]);
      else out.push([nodes[k], x + off, y, len, thick]);
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
}

/** `text` cut with an ellipsis to fit `max` pixels in the current font. */
CG.fit = function (ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
};

CG.MapView = class {
  constructor(app) {
    this.app = app;
    this.rects = [];
    this.byId = new Map();
    this.key = '';
  }

  layout() {
    const a = this.app, r = a.region;
    const key = [a.modelVersion, a.focus && a.focus.id, a.metric, r.x, r.y, r.w, r.h].join();
    if (key === this.key) return;
    this.key = key;
    this.rects = [];
    this.byId.clear();
    if (a.focus && a.focus.kids) this.placeKids(a.focus, r.x, r.y, r.w, r.h, 0);
  }

  placeKids(n, x, y, w, h, depth) {
    const m = this.app.metric;
    const kids = n.kids.filter((k) => CG.value(k, m) > 0).sort((p, q) => CG.value(q, m) - CG.value(p, m));
    if (!kids.length) return;
    const out = [];
    squarify(kids, kids.map((k) => CG.value(k, m)), x, y, w, h, out);
    for (const [k, kx, ky, kw, kh] of out) this.place(k, kx, ky, kw, kh, depth);
  }

  place(n, x, y, w, h, depth) {
    // a 1px gutter between neighbours lets the ground show as the divider
    const r = { node: n, x: x + 0.5, y: y + 0.5, w: w - 1, h: h - 1, depth, header: false };
    if (r.w < 1 || r.h < 1) return;
    this.rects.push(r);
    this.byId.set(n.id, r);
    if (!n.kids) return;
    if (r.w > 60 && r.h > 42) {
      r.header = true;
      this.placeKids(n, r.x + 3, r.y + 20, r.w - 6, r.h - 23, depth + 1);
    } else if (r.w > 6 && r.h > 6) this.placeKids(n, r.x + 1, r.y + 1, r.w - 2, r.h - 2, depth + 1);
  }

  draw(ctx, t) {
    this.layout();
    const a = this.app, q = a.matches, m = a.metric;
    if (!this.rects.length) {
      const r = a.region;
      ctx.fillStyle = t.text2;
      ctx.font = '13px Inter';
      ctx.textAlign = 'center';
      const what = m === 'lines' ? 'No lines counted here. Try Files or Size.' : 'Nothing to show here.';
      ctx.fillText(what, r.x + r.w / 2, r.y + r.h / 2);
      ctx.textAlign = 'left';
      return;
    }

    for (const r of this.rects) {
      const n = r.node;
      if (n.kids) {
        ctx.fillStyle = r.depth % 2 ? t.dirB : t.dirA;
        ctx.globalAlpha = q && !q.has(n.id) ? 0.5 : 1;
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, r.w > 30 && r.h > 30 ? 5 : 1.5);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (r.header) {
          ctx.font = '600 11.5px Inter';
          ctx.fillStyle = t.text2;
          const num = CG.short(n, m);
          const numW = ctx.measureText(num).width;
          const room = r.w - 14 - (r.w > 120 ? numW + 10 : 0);
          ctx.fillText(CG.fit(ctx, n.name, room), r.x + 7, r.y + 14);
          if (r.w > 120) {
            ctx.font = '11px Inter';
            ctx.fillText(num, r.x + r.w - 7 - ctx.measureText(num).width, r.y + 14);
          }
        }
      } else {
        ctx.globalAlpha = q && !q.has(n.id) ? 0.14 : 1;
        ctx.fillStyle = CG.langColor(n.lang);
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, r.w > 12 && r.h > 12 ? 3 : 0.5);
        ctx.fill();
        if (r.w > 44 && r.h > 17) {
          ctx.font = '500 11.5px Inter';
          ctx.fillStyle = t.label;
          ctx.fillText(CG.fit(ctx, n.name, r.w - 12), r.x + 6, r.y + 14);
          if (r.h > 34) {
            ctx.font = '11px Inter';
            ctx.fillStyle = t.labelSoft;
            ctx.fillText(CG.fit(ctx, CG.measure(n, m), r.w - 12), r.x + 6, r.y + 28);
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    this.outline(ctx, a.hover, t.strong, 1.5);
    this.outline(ctx, a.selected, t.accent, 2.5);
  }

  outline(ctx, n, color, width) {
    const r = n && this.byId.get(n.id);
    if (!r) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.roundRect(r.x + width / 2, r.y + width / 2, r.w - width, r.h - width, 3);
    ctx.stroke();
  }

  hit(x, y) {
    for (let i = this.rects.length - 1; i >= 0; i--) {
      const r = this.rects[i];
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.node;
    }
    return null;
  }
};
