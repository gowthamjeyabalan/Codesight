'use strict';
// Pan and zoom for the diagram views: screen = world * k + (x, y).
CG.Camera = class {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.k = 1;
  }

  pan(dx, dy) {
    this.x += dx;
    this.y += dy;
  }

  zoom(px, py, factor) {
    const k = Math.max(0.05, Math.min(3, this.k * factor));
    const f = k / this.k;
    this.x = px - (px - this.x) * f;
    this.y = py - (py - this.y) * f;
    this.k = k;
  }

  /** Shows the world box `b` ({x0, y0, x1, y1}) in the screen rectangle `r`. */
  fit(b, r, most = 1.25) {
    const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
    this.k = Math.max(0.05, Math.min((r.w - 40) / bw, (r.h - 40) / bh, most));
    this.x = r.x + (r.w - bw * this.k) / 2 - b.x0 * this.k;
    this.y = r.y + (r.h - bh * this.k) / 2 - b.y0 * this.k;
  }

  /** Moves the camera so the world point lands in the middle of `r`. */
  center(wx, wy, r) {
    this.x = r.x + r.w / 2 - wx * this.k;
    this.y = r.y + r.h / 2 - wy * this.k;
  }

  /** True when the world box is fully on screen inside `r`. */
  shows(x, y, w, h, r) {
    const sx = x * this.k + this.x, sy = y * this.k + this.y;
    return sx >= r.x && sy >= r.y && sx + w * this.k <= r.x + r.w && sy + h * this.k <= r.y + r.h;
  }

  toWorld(sx, sy) {
    return [(sx - this.x) / this.k, (sy - this.y) / this.k];
  }

  /** The world rectangle on screen. */
  visible() {
    // an export draws onto a canvas of its own size (CG.viewport)
    const w = CG.viewport ? CG.viewport.w : innerWidth, h = CG.viewport ? CG.viewport.h : innerHeight;
    return { x0: -this.x / this.k, y0: -this.y / this.k, x1: (w - this.x) / this.k, y1: (h - this.y) / this.k };
  }

  apply(ctx) {
    ctx.translate(this.x, this.y);
    ctx.scale(this.k, this.k);
  }
};

/** A filled arrowhead (or hollow, for inheritance) at (x, y) pointing along angle `a`. */
CG.arrow = function (ctx, x, y, a, size, hollow, fill) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(a - 0.45), y - size * Math.sin(a - 0.45));
  ctx.lineTo(x - size * Math.cos(a + 0.45), y - size * Math.sin(a + 0.45));
  ctx.closePath();
  if (hollow) {
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }
};
