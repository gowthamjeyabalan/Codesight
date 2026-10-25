'use strict';
// Making a flow easier to read: short call labels, what the author wrote about a method (its /// or // comment),
// a one-line summary in plain English, and the key under each drawing.

/** One argument, short: a long string keeps its first words, a long expression becomes the parameter's name. */
CG.shortArg = function (arg, param) {
  const a = arg.trim();
  const str = /^(\$@|@\$|\$|@)?"/.exec(a);
  if (str) {
    if (a.length <= 22) return a;
    // the words before the first {hole}, so $"Loaded: {name}" reads "Loaded: …"
    let words = a.slice(str[0].length).split(/[{"]/)[0].trim();
    if (words.length > 18) words = words.slice(0, 18).replace(/\s+\S*$/, '') || words.slice(0, 17);
    return words ? `"${words}${/[:\-–]$/.test(words) ? ' ' : ''}…"` : param || '"…"';
  }
  if (a.includes('=>')) return param ? `${param} (a lambda)` : '() => …';
  if (a.length <= 18) return a;
  return param || a.slice(0, 15).trim() + '…';
};

/** "(dlg.FileName)", "(\"Loaded: …\")": what goes into a call, short enough to read along the arrow. */
CG.shortArgs = function (s, max = 40) {
  if (!s.a) return '()';
  const pn = (s.member && s.member.pn) || [];
  const t = `(${s.a.map((x, i) => CG.shortArg(x, pn[i])).join(', ')})`;
  return t.length > max ? t.slice(0, max - 2) + '…)' : t;
};

/** The first sentence of what the author wrote about a member, or ''. */
CG.docLine = function (m, max = 90) {
  const said = m && m.doc && m.doc.s;
  if (!said) return '';
  const first = said.split(/(?<=[.!?])\s/)[0].replace(/[.:;]$/, '');
  return first.length > max ? first.slice(0, max - 1).trim() + '…' : first;
};

/** What the author wrote about a member, for the details panel: summary, parameters and what it returns. */
CG.docHtml = function (m) {
  const d = m && m.doc;
  if (!d) return '';
  let h = '<div class="doc">';
  if (d.s) h += `<div class="doc-s">${CG.esc(d.s)}</div>`;
  if (d.p) h += Object.entries(d.p).map(([k, v]) => `<div class="doc-p"><span class="name">${CG.esc(k)}</span> ${CG.esc(v)}</div>`).join('');
  if (d.r) h += `<div class="doc-p"><span class="name">returns</span> ${CG.esc(d.r)}</div>`;
  return h + '</div>';
};

// ── the one-line summary ──

const IRREGULAR = { do: 'does', go: 'goes', be: 'is', have: 'has', can: 'can', is: 'is', on: 'handles' };

/** "set" → "sets", "try" → "tries", "push" → "pushes". */
function thirdPerson(verb) {
  if (IRREGULAR[verb]) return IRREGULAR[verb];
  if (/(s|sh|ch|x|z|o)$/.test(verb)) return verb + 'es';
  if (/[^aeiou]y$/.test(verb)) return verb.slice(0, -1) + 'ies';
  return verb + 's';
}

/** "SetInputFile" → ["set", "input", "file"]; acronyms stay as they are. */
function words(name) {
  return name.replace(/Async$/, '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/).filter(Boolean).map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()));
}

const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

/** What a call does, as a phrase: from its comment when there is one, else from its name. */
function callPhrase(s) {
  const m = s.member;
  if (!m) return null;
  const said = CG.docLine(m, 110);
  // a comment that starts with a verb ("Sets the file", "Saves...") reads straight into the sentence
  if (said && /^[A-Z][a-z]+s\b/.test(said) && !/^(This|Its|His|Hers|Ours|Yours|Is|Has|Was)\b/.test(said)) return said[0].toLowerCase() + said.slice(1);
  if (m.k === 'ctor') { const w = words(m.type.n.replace(/<.*/, '')).join(' '); return `creates ${article(w)} ${w}`; }
  const w = words(m.n);
  if (!w.length) return null;
  const verb = thirdPerson(w[0]);
  let rest = w.slice(1).join(' ');
  // Log(message) reads "logs the message", order.Place() reads "places the order"
  if (!rest && m.pn && m.pn.length === 1) rest = 'the ' + words(m.pn[0]).join(' ');
  if (!rest && s.on) rest = 'the ' + words(m.type.n.replace(/<.*/, '').replace(/^I(?=[A-Z])/, '')).join(' ');
  return rest ? `${verb} ${rest}` : verb;
}

/** "a == null" → "a is missing", "x && y" → "x and y". Code stays code, the joints become words. */
function condText(c) {
  return c.replace(/\s*==\s*true\b/g, ' is true').replace(/\s*==\s*false\b/g, ' is false')
    .replace(/\s*!=\s*null\b/g, ' is set').replace(/\s*==\s*null\b/g, ' is missing')
    .replace(/\s*&&\s*/g, ' and ').replace(/\s*\|\|\s*/g, ' or ')
    .replace(/\s*!=\s*/g, ' is not ').replace(/\s*==\s*/g, ' is ').replace(/^!\s*/, 'not ');
}

function joinPhrases(list) {
  if (list.length <= 1) return list[0] || '';
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

/** Phrases for a list of steps: calls, decisions, loops and try blocks; not what happens inside the calls. */
function phrases(steps, budget) {
  const out = [];
  for (const s of steps) {
    if (budget.left <= 0) { budget.more++; continue; }
    if (s.k === 'call') {
      const p = callPhrase(s);
      if (p && !out.includes(p)) { out.push(p); budget.left--; }
    } else if (s.k === 'if' || s.k === 'switch') {
      const ways = s.b.filter((b) => b.s.length);
      if (!ways.length) continue;
      if (s.k === 'if') {
        const yes = joinPhrases(phrases(s.b[0].s, budget)), no = s.b[1] && s.b[1].s.length ? joinPhrases(phrases(s.b[1].s, budget)) : '';
        if (yes && no) out.push(`if ${condText(s.c)}, ${yes}; otherwise ${no}`);
        else if (yes) out.push(`if ${condText(s.c)}, ${yes}`);
        else if (no) out.push(`unless ${condText(s.c)}, ${no}`);
      } else out.push(`depending on ${s.c}, one of ${ways.length} things happens`);
      budget.left--;
    } else if (s.k === 'loop') {
      const inner = joinPhrases(phrases(s.s || [], budget));
      if (inner) { out.push(/^(for|while|until)\b/i.test(s.c) ? `${s.c}, ${inner}` : `repeatedly ${inner}`); budget.left--; }
    } else if (s.k === 'try') {
      const [tried, ...caught] = s.b;
      const main = joinPhrases(phrases(tried.s, budget));
      const handled = caught.find((b) => b.s.length);
      const what = handled ? joinPhrases(phrases(handled.s, budget)) : '';
      if (main && what) out.push(`${main}; if that fails${handled.ct ? ` with ${handled.ct}` : ''}, ${what}`);
      else if (main) out.push(main);
    } else if (s.k === 'throw') {
      out.push(`throws ${(s.tt && s.tt[0]) || 'an exception'}`);
      budget.left--;
    }
  }
  return out;
}

/** Who starts the flow, in words: "Clicking the “Browse...” button". */
function startText(entry, root) {
  const ui = entry.ui && /^(.+?) “(.+)” · (\w+)$/.exec(entry.ui);
  if (ui) {
    const kind = ui[1].toLowerCase();
    return ui[3] === 'Click' ? `Clicking the “${ui[2]}” ${kind}` : `When the “${ui[2]}” ${kind} raises ${ui[3]}`;
  }
  if (entry.ui) return `On ${entry.ui}`;
  const m = root.member || entry;
  if (entry.ep === 'main') return 'When the program starts, it';
  if (entry.ep === 'action') return `The ${m.type.n}.${m.n} web API action`;
  return `${m.type.n}.${m.n}`;
}

/** One line in plain English: "Clicking the “Browse...” button: if dlg.ShowDialog() is true, sets input file and logs." */
CG.flowSummary = function (data) {
  const budget = { left: 6, more: 0 };
  const list = phrases(data.root.s || [], budget);
  let text = startText(data.entry, data.root);
  if (!list.length) return `${text} does nothing else in your code.`;
  let body = joinPhrases(list);
  if (budget.more) body += `, then ${CG.plural(budget.more, 'more step')}`;
  text += /\bit$/.test(text) || !/^(if|unless|for|while|until|depending)\b/.test(body) ? ` ${body}` : `: ${body}`;
  return text.replace(/\s+/g, ' ') + '.';
};

// ── drawn around both flow drawings: the summary above, the key below ──

CG.wrapText = function (ctx, text, width) {
  const lines = [];
  let line = '';
  for (const w of text.split(' ')) {
    const next = line ? line + ' ' + w : w;
    if (line && ctx.measureText(next).width > width) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
};

const KEYS = {
  sequence: [
    ['call', 'calls a method'],
    ['return', 'returns, with what comes back'],
    ['self', 'calls a method of its own class'],
    ['bar', 'method running'],
    ['frag', 'opt: only if […] · alt: one way or another · loop: repeats · try: catches errors'],
    ['outside', 'outside your code'],
    ['open', 'double-click to open'],
  ],
  steps: [
    ['start', 'where it starts'],
    ['box', 'a call: what goes in → where its result goes'],
    ['decision', 'a decision, the ways split below'],
    ['loop', 'repeats'],
    ['frame', 'inside an opened call'],
    ['open', 'double-click to open'],
  ],
};

CG.FlowExtras = class {
  /** Lays out the summary over [x0, x1] above `top` and the key below `bottom`; returns the space they take. */
  constructor(ctx, app, style, data, x0, x1, top, bottom) {
    this.app = app;
    this.style = style;
    this.width = Math.min(Math.max(x1 - x0, 520), 900);
    this.x = x0;
    ctx.font = '500 13px Inter';
    this.lines = CG.wrapText(ctx, CG.flowSummary(data), Math.min(this.width, 640));
    this.top = top - 18 - this.lines.length * 19;
    this.items = [];
    let x = this.x, y = bottom + 34;
    ctx.font = '11.5px Inter';
    for (const [kind, text] of app.showKey ? KEYS[style] : []) {
      const w = 40 + ctx.measureText(text).width + 22;
      if (x > this.x && x + w > this.x + this.width) { x = this.x; y += 24; }
      this.items.push({ kind, text, x, y });
      x += w;
    }
    this.bottom = this.items.length ? y + 18 : bottom;
  }

  draw(ctx, t) {
    ctx.font = '500 13px Inter';
    ctx.fillStyle = t.text;
    this.lines.forEach((l, i) => ctx.fillText(l, this.x, this.top + 14 + i * 19));
    if (!this.items.length) return;
    ctx.strokeStyle = t.edgeSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.x, this.items[0].y - 16);
    ctx.lineTo(this.x + this.width, this.items[0].y - 16);
    ctx.stroke();
    for (const it of this.items) {
      this.sample(ctx, t, it.kind, it.x, it.y);
      ctx.font = '11.5px Inter';
      ctx.fillStyle = t.text2;
      ctx.fillText(it.text, it.x + 40, it.y + 4);
    }
  }

  /** A small drawing of each mark, 32 wide, centred on y. */
  sample(ctx, t, kind, x, y) {
    ctx.save();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = t.edge;
    ctx.fillStyle = t.card;
    switch (kind) {
      case 'call':
      case 'return':
        ctx.setLineDash(kind === 'return' ? [5, 4] : []);
        if (kind === 'return') ctx.strokeStyle = t.edgeSoft;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 30, y); ctx.stroke();
        ctx.setLineDash([]);
        CG.arrow(ctx, x + 31, y, 0, 7, false);
        break;
      case 'self':
        ctx.beginPath(); ctx.moveTo(x + 4, y - 6); ctx.lineTo(x + 26, y - 6); ctx.lineTo(x + 26, y + 6); ctx.lineTo(x + 10, y + 6); ctx.stroke();
        CG.arrow(ctx, x + 9, y + 6, Math.PI, 6, false);
        break;
      case 'bar':
        ctx.beginPath(); ctx.roundRect(x + 11, y - 9, 10, 18, 3); ctx.fill(); ctx.strokeStyle = t.cardStroke; ctx.stroke();
        break;
      case 'frag':
        ctx.beginPath(); ctx.roundRect(x, y - 9, 32, 18, 4); ctx.fillStyle = t.hoverSoft; ctx.fill(); ctx.strokeStyle = t.edgeSoft; ctx.stroke();
        ctx.font = '700 9px Inter'; ctx.fillStyle = t.text; ctx.fillText('opt', x + 3, y - 1);
        break;
      case 'outside':
        ctx.font = 'italic 12px Inter'; ctx.fillStyle = t.text2; ctx.fillText('Abc', x + 4, y + 4);
        break;
      case 'open':
        ctx.font = '11px Inter'; ctx.fillStyle = t.text2; ctx.fillText('▸', x + 12, y + 4);
        break;
      case 'start':
        ctx.beginPath(); ctx.roundRect(x, y - 8, 32, 16, 8); ctx.fillStyle = t.accentSoft; ctx.fill(); ctx.strokeStyle = t.accent; ctx.stroke();
        break;
      case 'box':
        ctx.beginPath(); ctx.roundRect(x, y - 8, 32, 16, 5); ctx.fill(); ctx.strokeStyle = t.cardStroke; ctx.stroke();
        break;
      case 'decision':
        ctx.beginPath();
        ctx.moveTo(x + 7, y - 8); ctx.lineTo(x + 25, y - 8); ctx.lineTo(x + 32, y); ctx.lineTo(x + 25, y + 8); ctx.lineTo(x + 7, y + 8); ctx.lineTo(x, y);
        ctx.closePath(); ctx.fill(); ctx.strokeStyle = t.text2; ctx.stroke();
        break;
      case 'loop':
        ctx.font = '500 12px Inter'; ctx.fillStyle = t.text; ctx.fillText('↻', x + 10, y + 4);
        break;
      case 'frame':
        ctx.beginPath(); ctx.roundRect(x, y - 9, 32, 18, 6); ctx.fillStyle = t.hoverSoft; ctx.fill();
        ctx.fillStyle = t.text2; ctx.fillRect(x, y - 5, 2.5, 10);
        break;
    }
    ctx.restore();
  }
};
