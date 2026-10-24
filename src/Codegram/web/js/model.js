'use strict';
// The folder tree from the extension, with totals per folder, and the formatting rules of the design system.
const CG = (window.CG = window.CG || {});

// Language id (from FolderScanner.cs) -> name and colour (Grapht categorical palette).
CG.LANGS = {
  cs: ['C#', '#b07aa1'],
  ts: ['TypeScript', '#4e79a7'],
  js: ['JavaScript', '#edc948'],
  py: ['Python', '#59a14f'],
  rs: ['Rust', '#f28e2b'],
  cpp: ['C and C++', '#76b7b2'],
  web: ['Web and UI', '#e15759'],
  data: ['Data and config', '#9c755f'],
  doc: ['Docs', '#bab0ac'],
  script: ['Scripts', '#ff9da7'],
  code: ['Other code', '#17becf'],
  other: ['Other files', '#80848c'],
};
CG.langName = (id) => (CG.LANGS[id] || CG.LANGS.other)[0];
CG.langColor = (id) => (CG.LANGS[id] || CG.LANGS.other)[1];

/** Builds nodes from the scanner's compact tree: folders first, then files, each sorted by name. */
CG.build = function (raw, rootName) {
  const nodes = [];
  const walk = (r, parent, depth) => {
    const n = { id: nodes.length, name: parent ? r.n : rootName || r.n, parent, depth, lines: 0, bytes: 0, files: 0 };
    nodes.push(n);
    n.path = !parent ? '' : parent.path ? parent.path + '/' + r.n : r.n;
    if (r.k) {
      n.kids = [];
      n.langs = {}; // language -> lines
      n.langFiles = {}; // language -> files
      const sorted = r.k.slice().sort((a, b) => !a.k - !b.k || a.n.localeCompare(b.n, undefined, { sensitivity: 'base' }));
      for (const k of sorted) {
        const c = walk(k, n, depth + 1);
        n.kids.push(c);
        n.lines += c.lines;
        n.bytes += c.bytes;
        n.files += c.files;
        if (c.kids) {
          for (const g in c.langs) n.langs[g] = (n.langs[g] || 0) + c.langs[g];
          for (const g in c.langFiles) n.langFiles[g] = (n.langFiles[g] || 0) + c.langFiles[g];
        } else {
          n.langs[c.lang] = (n.langs[c.lang] || 0) + c.lines;
          n.langFiles[c.lang] = (n.langFiles[c.lang] || 0) + 1;
        }
      }
    } else {
      n.lang = r.g || 'other';
      n.lines = r.c || 0;
      n.bytes = r.b || 0;
      n.files = 1;
    }
    return n;
  };
  const root = walk(raw, null, 0);
  return { root, nodes };
};

CG.value = (n, metric) => (metric === 'files' ? n.files : metric === 'bytes' ? n.bytes : n.lines);

/** The language with the most lines (or files) in a folder; a file's own language. */
CG.dominant = function (n) {
  if (!n.kids) return n.lang;
  let best = 'other', most = -1;
  for (const g in n.langFiles) {
    const v = (n.langs[g] || 0) * 1000 + n.langFiles[g];
    if (v > most) { most = v; best = g; }
  }
  return best;
};

CG.find = function (model, path) {
  if (path == null || !model) return null;
  if (path === '') return model.root;
  let n = model.root;
  for (const part of path.split('/')) {
    n = n.kids && n.kids.find((k) => k.name === part);
    if (!n) return null;
  }
  return n;
};

CG.ancestors = function (n) {
  const list = [];
  for (let p = n; p; p = p.parent) list.unshift(p);
  return list;
};

// ── formatting: no digit grouping, trimmed zeros, correct plurals ──
CG.trim = (x, digits) => String(+x.toFixed(digits));
CG.plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
CG.size = function (b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${CG.trim(b / 1024, 1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${CG.trim(b / 1024 / 1024, 1)} MB`;
  return `${CG.trim(b / 1024 / 1024 / 1024, 2)} GB`;
};
/** Short form of the measured value, for labels. */
CG.short = function (n, metric) {
  if (metric === 'bytes') return CG.size(n.bytes);
  const v = CG.value(n, metric);
  return v >= 10000 ? `${CG.trim(v / 1000, v >= 100000 ? 0 : 1)}k` : String(v);
};
CG.measure = function (n, metric) {
  if (metric === 'bytes') return CG.size(n.bytes);
  if (metric === 'files') return CG.plural(n.files, 'file');
  return CG.plural(n.lines, 'line');
};
CG.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
