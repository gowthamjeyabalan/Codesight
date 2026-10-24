'use strict';
// Wires the page together: messages from Visual Studio, the panels, the canvas views and the settings.
(function () {
  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const host = window.chrome && window.chrome.webview;
  const send = (message) => (host ? host.postMessage(message) : console.debug('[codegram]', message));
  const LIST_MAX = 300;

  // ── settings (per viewer, kept in the WebView profile) ──
  const defaults = { theme: 'vs', material: 'acrylic', alpha: 0.8, view: 'map', metric: 'lines', colorBy: 'language', follow: true, members: 'all', depth: 2, flowStyle: 'sequence', files: true, details: true };
  let settings = { ...defaults };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('codesight.settings') || '{}')); } catch { /* private or blocked storage */ }
  // the demo page (no Visual Studio) can open on a view and style: index.html?view=flow&flowStyle=steps&theme=light
  if (!(window.chrome && window.chrome.webview))
    for (const [k, v] of new URLSearchParams(location.search)) if (k in settings) settings[k] = v;
  const save = () => { try { localStorage.setItem('codesight.settings', JSON.stringify(settings)); } catch { /* ignore */ } };

  const app = (CG.app = {
    // folder map
    model: null, modelVersion: 0, info: null, rootPath: '',
    focus: null, selected: null, matches: null,
    // C# model
    code: null, codeVersion: 0, codeState: 'idle',
    csel: null, scope: null, callFocus: null, codeMatches: null,
    // flow: the starting member, its steps, the picked step
    flowEntry: null, flow: null, fsel: null, flowVersion: 0, flowLoads: 0, flowStyle: settings.flowStyle, trace: null,
    // problems: file colours, and the reach of a change shown in the Calls view
    colorBy: settings.colorBy, impact: null,
    // shared
    hover: null, metric: settings.metric, view: settings.view, membersMode: settings.members, depth: +settings.depth,
    region: { x: 0, y: 0, w: 0, h: 0 }, t: null, emptyMsg: null,
  });
  const views = { map: new CG.MapView(app), tree: new CG.TreeView(app), classes: new CG.ClassView(app), calls: new CG.CallView(app), flow: new CG.FlowView(app) };
  if (!views[app.view]) app.view = 'map';
  const view = () => views[app.view];
  const isCode = () => app.view === 'classes' || app.view === 'calls' || app.view === 'flow';
  const canPan = () => app.view !== 'map';
  const listOpen = new Set(); // folder paths open in the Files panel
  const codeOpen = new Set(); // namespaces and types open in the Types panel
  let hostDark = matchMedia('(prefers-color-scheme: dark)').matches;

  // ── theme and glass ──
  function applyTheme() {
    const dark = settings.theme === 'vs' ? hostDark : settings.theme === 'dark';
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.setProperty('--glass', settings.alpha);
    document.body.classList.toggle('acrylic', settings.material === 'acrylic');
    const cs = getComputedStyle(root);
    const v = (name) => cs.getPropertyValue(name).trim();
    app.t = {
      dark,
      text: v('--text'), text2: v('--text-secondary'), accent: v('--accent'),
      card: v('--inner-card-fill'), cardStroke: v('--inner-card-stroke'), cardHover: v('--bg-control'),
      dirA: dark ? '#26262a' : '#d9d9df', dirB: dark ? '#2e2e33' : '#e3e3e8',
      strong: dark ? '#ffffff' : '#111318',
      edge: dark ? 'rgba(152,152,162,0.42)' : 'rgba(82,82,90,0.42)',
      edgeSoft: dark ? 'rgba(152,152,162,0.28)' : 'rgba(82,82,90,0.28)',
      accentSoft: dark ? 'rgba(10,132,255,0.22)' : 'rgba(10,132,255,0.16)',
      hoverSoft: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
      label: 'rgba(20,22,28,0.9)', labelSoft: 'rgba(20,22,28,0.62)',
      danger: v('--danger'), accentText: v('--accent-text'), labelBg: v('--bg-control'), warn: v('--warning'), canvas: v('--canvas'),
    };
    redraw();
  }

  // ── layout ──
  function layout() {
    const W = innerWidth, H = innerHeight;
    const roomy = W >= 700;
    const showFiles = settings.files && roomy, showDetails = settings.details && roomy;
    $('files').hidden = !showFiles;
    $('details').hidden = !showDetails;
    $('toggle-files').classList.toggle('on', settings.files);
    $('toggle-details').classList.toggle('on', settings.details);
    $('metric').hidden = isCode();
    $('members').hidden = app.view !== 'classes';
    $('depth-group').hidden = app.view !== 'calls';
    $('flowstyle').hidden = app.view !== 'flow';
    $('exc-toggle').hidden = app.view !== 'flow';
    $('exc-toggle').classList.toggle('on', !!(app.trace && app.trace.name === 'exceptions'));
    $('colorby').hidden = app.view !== 'map' && app.view !== 'tree';
    if (app.impact) $('depth-group').hidden = true;
    const left = showFiles ? 284 : 10, right = showDetails ? 284 : 10;
    const crumbs = !!app.model && $('empty').hidden && hasCrumbs();
    const top = crumbs ? 100 : 64;
    app.region = { x: left, y: top, w: Math.max(60, W - left - right), h: Math.max(60, H - top - 34) };
    $('crumbs').hidden = !crumbs;
    $('crumbs').style.left = left + 'px';
    $('status').style.left = left + 4 + 'px';

    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    redraw();
  }

  let pending = false;
  function redraw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(paint);
  }
  function paint() {
    pending = false;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!app.t || !$('empty').hidden) return;
    if (isCode() ? app.code && app.code.types.length : app.model) view().draw(ctx, app.t);
    if (isCode()) statusLine();
  }

  // ── what to say when there is nothing to draw ──
  function refreshEmpty() {
    let msg = null;
    if (!app.model) msg = app.emptyMsg;
    else if (isCode()) {
      const c = app.code;
      if (!c) msg = app.codeState === 'analyzing' || !host ? ['Reading C# projects', 'The first read of a big solution can take a moment.'] : null;
      else if (!c.types.length && c.info.error) msg = ['Could not read the C# code', c.info.error];
      else if (!c.types.length) msg = ['No C# code found', 'Codesight reads the C# projects of the open solution. Open a .sln file to see its classes and calls.'];
    }
    $('empty').hidden = !msg;
    if (msg) {
      $('empty-title').textContent = msg[0];
      $('empty-hint').textContent = msg[1];
    }
  }

  function setStatus(html) {
    if ($('status').innerHTML !== html) $('status').innerHTML = html;
  }
  function statusLine() {
    if (isCode()) {
      const c = app.code;
      if (!c || !c.types.length) return setStatus('');
      const i = c.info;
      let s = `${CG.plural(c.types.length, 'type')}, ${CG.plural(c.methods, 'method')}, ${CG.plural(c.calls, 'call')}`;
      if (i.seconds != null) s += ` · read in ${CG.trim(i.seconds, 2)} s`;
      if (app.codeState === 'analyzing') s += ' · updating…';
      if (app.view === 'flow') {
        const f = app.flow;
        if (!f || f.state !== 'ready') return setStatus(f && f.state === 'loading' ? 'Following the code…' : '');
        let fs = `${CG.plural(f.data.calls, 'call')} through ${CG.plural(f.data.classes, 'class', 'classes')}`;
        if (f.data.stopped) fs += ` · <span class="warn">Stopped after ${f.budget} calls.</span>`;
        return setStatus(fs + ' · double-click a call to open or close it');
      }
      if (app.view === 'calls' && app.impact) {
        const im = app.impact;
        return setStatus(`Changing ${CG.esc(im.target.label || im.target.n)} reaches ${CG.plural(im.affected.length, 'method')} in ${CG.plural(im.types.size, 'class', 'classes')}, from ${CG.plural(im.entries.length, 'starting point')}`);
      }
      const cv = views.classes;
      if (app.view === 'classes' && cv.total > CG.ClassView.MAX_TYPES) s += ` · <span class="warn">Showing ${CG.ClassView.MAX_TYPES} of ${cv.total} types. Pick a smaller namespace or a type.</span>`;
      if (i.truncated) s += ` · <span class="warn">Stopped at ${i.maxTypes} types.</span>`;
      return setStatus(s);
    }
    if (!app.model) return setStatus('');
    const i = app.info, r = app.model.root;
    let s = `${CG.plural(r.files, 'file')}, ${CG.plural(r.lines, 'line')}, ${CG.size(r.bytes)}`;
    if (i && i.seconds != null) s += ` · mapped in ${i.seconds < 0.01 ? 'under 0.01' : CG.trim(i.seconds, 2)} s`;
    if (i && i.truncated) s += ` · <span class="warn">Stopped at ${i.maxFiles} files.</span>`;
    if (app.colorBy === 'complexity')
      s += app.code
        ? ' · complexity of the most complex method:' + CG.CX_BANDS.map((b) => `<span class="legend"><i style="background:${b.color}"></i>${b.label}</span>`).join('')
        : ' · reading C# for complexity…';
    setStatus(s);
  }

  // ── messages from Visual Studio ──
  function onHost(m) {
    switch (m.type) {
      case 'theme':
        hostDark = !!m.dark;
        applyTheme();
        break;
      case 'empty':
        app.model = app.code = null;
        app.selected = app.focus = app.hover = app.csel = app.scope = app.callFocus = null;
        app.codeState = 'idle';
        app.emptyMsg = ['No solution open', 'Open a solution or a folder and Codesight maps it here.'];
        renderAll();
        break;
      case 'scanning':
        if (!app.model || app.rootPath !== m.root) {
          app.model = null;
          app.emptyMsg = [`Mapping ${m.name}`, 'Reading folders and counting lines.'];
          renderAll();
        } else if (!isCode()) setStatus('Updating…');
        break;
      case 'tree':
        load(m);
        break;
      case 'analyzing':
        app.codeState = 'analyzing';
        if (!app.code) renderAll();
        else statusLine();
        break;
      case 'code':
        loadCode(m);
        break;
      case 'flowResult':
        loadFlow(m);
        break;
      case 'caret':
        followCaret(m);
        break;
      case 'saved':
        setStatus(m.error ? `<span class="warn">Could not save: ${CG.esc(m.error)}</span>` : `Saved to ${CG.esc(m.path)}`);
        break;
      case 'copied':
        setStatus(m.error ? `<span class="warn">${CG.esc(m.error)}</span>` : 'Copied as Mermaid. Paste it into Markdown, GitHub or any Mermaid viewer.');
        break;
    }
  }

  function load(m) {
    const same = app.model && app.rootPath === m.root;
    const keepSelected = app.selected && app.selected.path;
    const keepFocus = app.focus && app.focus.path;
    app.model = CG.build(m.tree, m.name);
    app.modelVersion++;
    app.rootPath = m.root;
    app.info = m;
    app.hover = null;
    app.emptyMsg = null;
    if (same) {
      app.focus = CG.find(app.model, keepFocus);
      app.selected = CG.find(app.model, keepSelected);
      views.tree.modelChanged();
    } else {
      app.focus = app.selected = null;
      listOpen.clear();
      views.tree.reset(app.model);
      // another folder: its C# is another solution
      app.code = app.csel = app.scope = app.callFocus = null;
      app.codeState = 'idle';
    }
    if (!app.focus || !app.focus.kids) app.focus = app.model.root;
    search();
    renderAll();
    ensureCode(app.colorBy === 'complexity');
  }

  /** Asks for the C# model the first time a code view is shown. */
  function ensureCode(always) {
    if (!(isCode() || always) || app.code || app.codeState === 'analyzing' || !app.model) return;
    app.codeState = 'analyzing';
    if (host) send({ type: 'analyze' });
    else setTimeout(() => onHost(CG.sampleCode()), 250);
    renderAll();
  }

  function loadCode(m) {
    const keep = { sel: CG.codeKey(app.csel), focus: CG.codeKey(app.callFocus), scope: app.scope };
    app.code = CG.buildCode(m);
    app.codeVersion++;
    app.codeState = 'ready';
    app.hover = null;
    app.csel = CG.findCode(app.code, keep.sel);
    app.callFocus = CG.findCode(app.code, keep.focus);
    app.scope = null;
    const s = keep.scope;
    if (s && s.kind === 'ns') { const ns = CG.findCode(app.code, s.key); if (ns) setScope(scopeNs(ns)); }
    if (s && s.kind === 'type') { const t = CG.findCode(app.code, s.key); if (t) setScope(scopeType(t)); }
    if (s && s.kind === 'files') { const n = CG.find(app.model, s.path); const types = CG.typesUnder(app.code, n); if (types.length) setScope(scopeFiles(n, types)); }
    if (!app.scope) defaultScope();
    if (!app.callFocus) app.callFocus = CG.busiest(app.code.members);
    if (app.impact) {
      const target = CG.findCode(app.code, CG.codeKey(app.impact.target));
      app.impact = target ? CG.impactOf(target) : null;
    }
    const entryKey = app.flowEntry && CG.codeKey(app.flowEntry);
    app.flowEntry = CG.findCode(app.code, entryKey);
    app.flow = null;
    app.fsel = null;
    codeSearch();
    renderAll();
    ensureFlow();
  }

  // ── flows ──
  /** A good first flow: a button or other event, then a command or API action, then the busiest method. */
  function defaultEntry() {
    const c = app.code;
    if (!c) return null;
    for (const kind of ['event', 'command', 'action', 'main']) {
      const list = c.members.filter((x) => x.ep === kind);
      const best = list.find((x) => x.ui) || list[0];
      if (best) return best;
    }
    return app.csel && app.csel.ck === 'member' && CG.isMethod(app.csel) ? app.csel : CG.busiest(c.members);
  }

  /** Asks for the flow of the starting member, when the Flow view needs one. */
  function ensureFlow() {
    if (app.view !== 'flow' || !app.code || !app.code.types.length) return;
    if (!app.flowEntry) app.flowEntry = defaultEntry();
    if (app.flowEntry && !app.flow) requestFlow(app.flowEntry);
  }

  function requestFlow(x) {
    if (!x || !CG.isMethod(x)) return;
    app.flowEntry = x;
    app.flow = { state: 'loading', id: x.id };
    app.fsel = null;
    app.trace = null;
    app.flowVersion++;
    if (host) send({ type: 'flow', id: x.id });
    else setTimeout(() => onHost({ type: 'flowResult', id: x.id, flow: CG.sampleFlow(app.code, x), budget: 2500 }), 120);
    renderAll();
  }

  function loadFlow(m) {
    if (!app.flowEntry || m.id !== app.flowEntry.id || !app.code) return;
    if (m.error || !m.flow) app.flow = { state: 'error', id: m.id, error: m.error || 'Nothing to follow.' };
    else app.flow = { state: 'ready', id: m.id, budget: m.budget, data: CG.prepareFlow(m.flow, app.code, app.flowEntry) };
    app.flowVersion++;
    app.flowLoads++;
    app.fsel = null;
    app.trace = null;
    renderAll();
  }

  function toggleStep(s) {
    if (!CG.canOpen(s)) return false;
    s.open = !s.open;
    app.flowVersion++;
    renderDetails();
    redraw();
    return true;
  }

  function setAllOpen(open) {
    const f = app.flow;
    if (!f || f.state !== 'ready') return;
    const walk = (s) => {
      if (CG.canOpen(s)) s.open = open;
      (s.s || []).forEach(walk);
      (s.b || []).forEach((b) => b.s.forEach(walk));
    };
    walk(f.data.root);
    app.flowVersion++;
    redraw();
  }

  function selectStep(s, from) {
    app.fsel = s;
    if (s && from !== 'canvas') views.flow.reveal(ctx, s);
    renderDetails();
    redraw();
  }

  /** Opens the line a step is on (the call site for a call). */
  function gotoStep(s) {
    if (!s) return;
    if (host) send({ type: 'goto', path: s.f, line: s.l });
    else setStatus(`In Visual Studio this opens ${CG.esc(s.f)} at line ${s.l + 1}.`);
  }

  // ── impact: what a change reaches ──
  function startImpact(x) {
    if (!x || (x.ck !== 'member' && x.ck !== 'type')) return;
    app.impact = CG.impactOf(x);
    app.csel = null;
    if (app.view !== 'calls') switchView('calls');
    else renderAll();
  }

  function stopImpact() {
    const target = app.impact && app.impact.target;
    app.impact = null;
    if (target && target.ck === 'member' && CG.isMethod(target)) app.callFocus = target;
    renderAll();
  }

  // ── exceptions in a flow ──
  function showExceptions() {
    const f = app.flow;
    if (!f || f.state !== 'ready') return;
    const map = CG.exceptionMap(f.data);
    const roles = new Map(), tones = new Map();
    for (const c of map.throws) {
      const where = c.branch ? `${c.branch.c}${c.by.l != null ? ` (line ${c.by.l + 1})` : ''}` : '';
      roles.set(c.step, c.by ? (c.maybe ? `may be caught: ${c.branch.c}` : `caught: ${c.branch.c}`) : 'not caught');
      if (!c.by) tones.set(c.step, 'danger');
      c.where = where;
      for (let p = c.step.parent; p; p = p.parent) if (CG.canOpen(p)) p.open = true;
    }
    for (const [tryStep, count] of map.catches) roles.set(tryStep, `catches ${count}`);
    const list = [];
    const visit = (s) => {
      if (roles.has(s)) list.push({ step: s, role: roles.get(s) });
      (s.s || []).forEach(visit);
      (s.b || []).forEach((b) => b.s.forEach(visit));
    };
    visit(f.data.root);
    app.trace = { name: 'exceptions', title: 'Exceptions in this flow', roles, tones, list, exceptions: map };
    app.flowVersion++;
    renderDetails();
    layout();
  }

  // ── following the editor ──
  /** The editor's caret moved: show the same place in the open view. */
  function followCaret(m) {
    if (!settings.follow || !m.path) return;
    const rel = m.path.replace(/\\/g, '/'), path = rel.toLowerCase(), line = m.line;
    const c = app.code;
    let member = null, type = null;
    if (c) {
      for (const x of c.members)
        if (x.file.toLowerCase() === path && x.l <= line && line <= x.le && (!member || x.le - x.l < member.le - member.l)) member = x;
      for (const t of c.types)
        if (t.f.toLowerCase() === path && t.l <= line && line <= t.le && (!type || t.le - t.l < type.le - type.l)) type = t;
    }
    switch (app.view) {
      case 'map':
      case 'tree': {
        const n = app.model && CG.find(app.model, rel);
        if (n && n !== app.selected) select(n, 'editor');
        break;
      }
      case 'classes': {
        const x = member || type;
        if (x && x !== app.csel) selectCode(x, 'editor');
        break;
      }
      case 'calls':
        if (member && CG.isMethod(member) && member !== app.csel) {
          if (!app.impact && !views.calls.byMember.has(member)) app.callFocus = member;
          selectCode(member, 'editor');
        }
        break;
      case 'flow': {
        const f = app.flow;
        if (!f || f.state !== 'ready') break;
        // the step on the caret's line, or else the call into the method the caret is in
        let best = null;
        const find = (test) => {
          const visit = (s) => {
            if (best) return;
            if (test(s)) best = s;
            (s.s || []).forEach(visit);
            (s.b || []).forEach((b) => b.s.forEach(visit));
          };
          visit(f.data.root);
        };
        find((s) => s.f && s.f.toLowerCase() === path && s.l === line);
        if (!best && member) find((s) => s.member === member);
        if (best && best !== app.fsel) {
          for (let p = best.parent; p; p = p.parent)
            if (CG.canOpen(p) && !p.open) { p.open = true; app.flowVersion++; }
          selectStep(best, 'editor');
        }
        break;
      }
    }
  }

  // ── export ──
  const VIEW_NAMES = { map: 'Map', tree: 'Tree', classes: 'Classes', calls: 'Calls', flow: 'Flow' };

  function exportName() {
    let what = '';
    if (app.view === 'flow' && app.flowEntry) what = app.flowEntry.ui || app.flowEntry.label;
    else if (app.view === 'calls') what = app.impact ? `Impact of ${app.impact.target.label || app.impact.target.n}` : app.callFocus ? app.callFocus.label : '';
    else if (app.view === 'classes' && app.scope) what = app.scope.ns ? app.scope.ns.name : app.scope.type ? app.scope.type.n : app.scope.path;
    else if (app.model) what = app.focus ? app.focus.name : app.model.root.name;
    return `Codesight ${VIEW_NAMES[app.view]}${what ? ' - ' + what : ''}`.replace(/[\\/:*?"<>|]/g, '');
  }

  /** Draws the whole diagram (not just what is on screen) onto `make(w, h)`'s context. */
  function renderExport(make) {
    const v = view(), t = app.t, pad = 32;
    const oldRegion = app.region;
    let w, h, restore;
    if (app.view === 'map') {
      w = Math.max(oldRegion.w, 1200);
      h = Math.max(oldRegion.h, 800);
      app.region = { x: pad, y: pad, w, h };
      w += pad * 2;
      h += pad * 2;
      restore = () => { views.map.key = ''; };
    } else {
      v.layout(ctx);
      const b = v.bounds();
      if (!isFinite(b.x0)) return null;
      w = b.x1 - b.x0 + pad * 2;
      h = b.y1 - b.y0 + pad * 2;
      const cam = { x: v.cam.x, y: v.cam.y, k: v.cam.k }, fit = v.fitPending;
      Object.assign(v.cam, { x: pad - b.x0, y: pad - b.y0, k: 1 });
      v.fitPending = false;
      app.region = { x: 0, y: 0, w, h };
      restore = () => { Object.assign(v.cam, cam); v.fitPending = fit; };
    }
    CG.viewport = { w, h };
    const hover = app.hover;
    app.hover = null;
    const c = make(w, h);
    c.fillStyle = t.canvas;
    c.fillRect(0, 0, w, h);
    try { v.draw(c, t); }
    finally {
      CG.viewport = null;
      app.hover = hover;
      app.region = oldRegion;
      restore();
      redraw();
    }
    return { c, w, h };
  }

  function mermaidText() {
    switch (app.view) {
      case 'classes': views.classes.layout(ctx); return CG.mermaid.classes(views.classes);
      case 'calls': views.calls.layout(ctx); return CG.mermaid.calls(views.calls, app.callFocus);
      case 'flow': return app.flow && app.flow.state === 'ready' ? (app.flowStyle === 'steps' ? CG.mermaid.steps(app.flow.data) : CG.mermaid.sequence(app.flow.data)) : null;
      default: return app.model ? CG.mermaid.tree(app.model, views.tree.open) : null;
    }
  }

  /** Hands a file to Visual Studio to save, or downloads it in a plain browser. */
  function saveFile(name, filter, text, base64, mime) {
    if (host) return send({ type: 'save', name, filter, text, base64 });
    const a = document.createElement('a');
    a.href = base64 ? `data:${mime};base64,${base64}` : URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    a.click();
  }

  function exportAs(kind) {
    $('export-pop').hidden = true;
    const name = exportName();
    if (kind === 'png') {
      let canvasEl = null, scale = 2;
      const out = renderExport((w, h) => {
        scale = Math.min(2, 16000 / Math.max(w, h));
        canvasEl = document.createElement('canvas');
        canvasEl.width = Math.ceil(w * scale);
        canvasEl.height = Math.ceil(h * scale);
        const c = canvasEl.getContext('2d');
        c.scale(scale, scale);
        return c;
      });
      if (!out) return setStatus('<span class="warn">Nothing to export yet.</span>');
      saveFile(name + '.png', 'PNG image|*.png', null, canvasEl.toDataURL('image/png').split(',')[1], 'image/png');
    } else if (kind === 'svg') {
      let svg = null;
      const out = renderExport((w, h) => (svg = new CG.SvgContext(w, h)));
      if (!out) return setStatus('<span class="warn">Nothing to export yet.</span>');
      saveFile(name + '.svg', 'SVG image|*.svg', svg.toString(), null, 'image/svg+xml');
    } else {
      const text = mermaidText();
      if (!text) return setStatus('<span class="warn">Nothing to export yet.</span>');
      if (kind === 'mermaid-copy') {
        if (host) send({ type: 'copy', text });
        else navigator.clipboard.writeText(text).then(() => onHost({ type: 'copied' }));
      } else saveFile(name + '.mmd', 'Mermaid diagram|*.mmd', text, null, 'text/plain');
    }
  }

  // ── code scopes (what the Classes view shows) ──
  const scopeNs = (ns) => ({ kind: 'ns', ns, key: CG.codeKey(ns) });
  const scopeType = (type) => ({ kind: 'type', type, key: CG.codeKey(type) });
  const scopeFiles = (node, types) => ({ kind: 'files', node, path: node.path, types, key: 'F:' + node.path });
  function setScope(s) {
    app.scope = s;
  }
  function defaultScope() {
    const c = app.code;
    if (!c || !c.types.length) return;
    const fromMap = app.selected && CG.typesUnder(c, app.selected);
    if (fromMap && fromMap.length) return setScope(scopeFiles(app.selected, fromMap));
    const biggest = c.namespaces.slice().sort((p, q) => q.types.length - p.types.length)[0];
    setScope(scopeNs(biggest));
  }
  /** True when the Classes view currently draws this type. */
  const shown = (t) => views.classes.byId.has(t.id) && views.classes.key.startsWith(app.codeVersion + '|' + (app.scope && app.scope.key));

  // ── selection and navigation ──
  function select(n, from) {
    app.selected = n;
    if (n && from !== 'list') for (let p = n.parent; p && p.parent; p = p.parent) listOpen.add(p.path);
    if (n && app.view === 'map' && !isInside(n, app.focus)) zoomTo(n.parent || app.model.root, true);
    if (n && app.view === 'tree' && from !== 'canvas') views.tree.reveal(ctx, n);
    renderList(from !== 'list');
    renderDetails();
    redraw();
  }

  function selectCode(x, from) {
    app.csel = x;
    if (x) {
      const t = x.ck === 'member' ? x.type : x.ck === 'type' ? x : null;
      if (t) codeOpen.add('N:' + t.ns);
      if (x.ck === 'member' && app.view === 'calls') codeOpen.add('T:' + t.id);
      if (from !== 'canvas') {
        if (app.view === 'classes' && t) {
          if (!shown(t)) setScope(scopeType(t));
          views.classes.reveal(ctx, x);
        }
        if (app.view === 'calls' && x.ck === 'member') views.calls.reveal(ctx, x);
      }
    }
    renderCrumbs();
    renderList(from !== 'list');
    renderDetails();
    layout();
  }

  function focusCalls(x) {
    if (!x || !CG.isMethod(x)) return;
    app.impact = null;
    app.callFocus = x;
    app.csel = x;
    if (app.view !== 'calls') switchView('calls');
    else renderAll();
  }

  function isInside(n, folder) {
    for (let p = n.parent; p; p = p.parent) if (p === folder) return true;
    return false;
  }

  function zoomTo(folder, quiet) {
    if (!folder || !folder.kids) return;
    app.focus = folder;
    renderCrumbs();
    if (!quiet) { renderDetails(); redraw(); }
  }

  function openFile(n) {
    if (n && !n.kids) send({ type: 'open', path: n.path });
  }

  /** Opens the declaration of a type or member in the editor. */
  function goto(x) {
    if (!x || (x.ck !== 'type' && x.ck !== 'member')) return;
    const path = x.ck === 'member' ? x.file : x.f;
    if (host) send({ type: 'goto', path, line: x.l });
    else setStatus(`In Visual Studio this opens ${CG.esc(path)} at line ${x.l + 1}.`);
  }

  function switchView(v) {
    const from = app.view;
    app.view = settings.view = v;
    save();
    app.hover = null;
    document.querySelectorAll('#view button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    if (v === 'tree' && app.selected) views.tree.reveal(ctx, app.selected);
    // a file or folder picked on the map carries over to the code views
    if (app.code && (from === 'map' || from === 'tree') && app.selected) {
      const types = CG.typesUnder(app.code, app.selected);
      if (types.length && v === 'classes') setScope(scopeFiles(app.selected, types));
      if (types.length && v === 'calls') {
        const best = CG.busiest(types.flatMap((t) => t.m));
        if (best) app.callFocus = best;
      }
    }
    ensureCode();
    ensureFlow();
    renderAll();
  }

  // ── breadcrumb ──
  let crumbActions = [];
  function hasCrumbs() {
    if (app.view === 'map') return true;
    if (app.view === 'classes') return !!(app.code && app.scope);
    if (app.view === 'calls') return !!(app.code && (app.callFocus || app.impact));
    if (app.view === 'flow') return !!(app.code && app.flowEntry);
    return false;
  }
  function renderCrumbs() {
    crumbActions = [];
    const parts = [];
    const add = (label, act) => parts.push(`<button data-i="${crumbActions.push(act) - 1}">${CG.esc(label)}</button>`);
    if (app.view === 'map' && app.model) {
      for (const p of CG.ancestors(app.focus)) add(p.name, () => zoomTo(p));
    } else if (app.view === 'classes' && app.code && app.scope) {
      const s = app.scope;
      if (s.kind === 'ns') add(s.ns.name, () => selectCode(s.ns, 'crumb'));
      if (s.kind === 'files') add(s.path || app.model.root.name, () => selectCode(null, 'crumb'));
      if (s.kind === 'type') {
        const ns = app.code.namespaces.find((n) => n.key === s.type.ns);
        add(ns.name, () => { setScope(scopeNs(ns)); selectCode(ns, 'crumb'); });
        add(`${s.type.n} and its relations`, () => selectCode(s.type, 'crumb'));
      }
    } else if (app.view === 'calls' && app.code && app.impact) {
      add('Back to calls', () => stopImpact());
      add(`Impact of ${app.impact.target.label || app.impact.target.n}`, () => selectCode(app.impact.target, 'crumb'));
    } else if (app.view === 'calls' && app.code && app.callFocus) {
      const f = app.callFocus;
      add(f.type.full, () => selectCode(f.type, 'crumb'));
      add(f.k === 'ctor' ? 'new' : f.n, () => selectCode(f, 'crumb'));
    } else if (app.view === 'flow' && app.code && app.flowEntry) {
      const e = app.flowEntry;
      add(e.type.full, () => selectStep(null, 'crumb'));
      add(e.ui ? `${e.n} · ${e.ui}` : e.n, () => selectStep(app.flow && app.flow.data ? app.flow.data.root : null, 'crumb'));
    }
    $('crumbs').innerHTML = parts.join('<span class="sl">/</span>');
  }
  $('crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) crumbActions[+b.dataset.i]();
  });

  // ── left panel: Files, or Types and Methods ──
  function renderList(scroll) {
    const title = app.view === 'classes' ? 'Types' : app.view === 'calls' ? 'Methods' : app.view === 'flow' ? 'Start from' : 'Files';
    $('files-title').textContent = title;
    $('toggle-files').textContent = title;
    if (isCode()) renderCodeList();
    else renderFileList();
    if (scroll) {
      const sel = $('list').querySelector('.row.sel');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderFileList() {
    const list = $('list');
    if (!app.model) { list.innerHTML = ''; $('files-sub').textContent = ''; return; }
    const m = app.metric, out = [];
    const row = (k, depth, label, sub) => {
      const open = k.kids && listOpen.has(k.path);
      const dot = k.kids
        ? `<span class="dot" style="border:1.6px solid ${CG.langColor(CG.dominant(k))}"></span>`
        : `<span class="dot" style="background:${CG.langColor(k.lang)}"></span>`;
      return `<div class="row${k === app.selected ? ' sel' : ''}" data-id="${k.id}" style="padding-left:${6 + depth * 14}px" title="${CG.esc(sub || k.path)}">` +
        `<span class="chev">${k.kids ? (open ? '▾' : '▸') : ''}</span>${dot}<span class="name">${CG.esc(label || k.name)}</span><span class="num">${CG.short(k, m)}</span></div>`;
    };

    if (app.matches) {
      // a search lists the matching files flat, largest first
      const hits = app.model.nodes.filter((n) => !n.kids && app.matches.has(n.id)).sort((p, q) => CG.value(q, m) - CG.value(p, m));
      for (const n of hits.slice(0, LIST_MAX)) out.push(row(n, 0, n.name, n.path));
      if (hits.length > LIST_MAX) out.push(`<div class="row more">${hits.length - LIST_MAX} more</div>`);
      $('files-sub').textContent = hits.length ? CG.plural(hits.length, 'match', 'matches') : 'nothing matches';
    } else {
      const add = (n, depth) => {
        for (let i = 0; i < n.kids.length; i++) {
          if (i === LIST_MAX) {
            out.push(`<div class="row more" style="padding-left:${24 + depth * 14}px">${n.kids.length - LIST_MAX} more</div>`);
            break;
          }
          const k = n.kids[i];
          out.push(row(k, depth));
          if (k.kids && listOpen.has(k.path)) add(k, depth + 1);
        }
      };
      add(app.model.root, 0);
      $('files-sub').textContent = app.model.root.name;
    }
    list.innerHTML = out.join('');
  }

  function renderCodeList() {
    const list = $('list'), c = app.code;
    if (!c) { list.innerHTML = ''; $('files-sub').textContent = ''; return; }
    const calls = app.view === 'calls' || app.view === 'flow', out = [];
    const pad = (depth) => `padding-left:${6 + depth * 14}px`;
    const sel = (x) => (x === (app.view === 'flow' ? app.flowEntry : app.csel) ? ' sel' : '');
    const nsRow = (ns) =>
      `<div class="row${sel(ns)}" data-k="ns" data-id="${ns.index}" style="${pad(0)}" title="${CG.esc(ns.name)}"><span class="chev">${codeOpen.has('N:' + ns.key) ? '▾' : '▸'}</span>` +
      `<span class="dot" style="border:1.6px solid var(--text-secondary)"></span><span class="name">${CG.esc(ns.name)}</span><span class="num">${ns.types.length}</span></div>`;
    const typeRow = (t, depth, label) => {
      const methods = t.m.filter(CG.isMethod).length;
      const chev = calls && methods ? (codeOpen.has('T:' + t.id) ? '▾' : '▸') : '';
      return `<div class="row${sel(t)}" data-k="type" data-id="${t.id}" style="${pad(depth)}" title="${CG.esc(t.full)}"><span class="chev">${chev}</span>` +
        `<span class="dot" style="background:${CG.kindColor(t.k)}"></span><span class="name">${CG.esc(label || t.n)}</span><span class="num">${calls ? methods : t.m.length}</span></div>`;
    };
    const memberRow = (x, depth, label) =>
      `<div class="row${sel(x)}" data-k="member" data-id="${x.id}" style="${pad(depth)}" title="${CG.esc(x.label + x.s)}"><span class="chev"></span>` +
      `<span class="glyph-col">${CG.ACCESS[x.a] || ''}</span><span class="name">${CG.esc(label || (x.k === 'ctor' ? 'new' : x.n))}</span><span class="num">${x.in.size + x.out.size}</span></div>`;

    if (app.codeMatches) {
      const hits = calls
        ? c.members.filter((x) => CG.isMethod(x) && app.codeMatches.has(x.id))
        : c.types.filter((t) => app.codeMatches.has(t.id));
      for (const x of hits.slice(0, LIST_MAX)) out.push(calls ? memberRow(x, 0, x.label) : typeRow(x, 0, x.n));
      if (hits.length > LIST_MAX) out.push(`<div class="row more">${hits.length - LIST_MAX} more</div>`);
      $('files-sub').textContent = hits.length ? CG.plural(hits.length, 'match', 'matches') : 'nothing matches';
    } else {
      if (app.view === 'flow') {
        const groups = [['event', 'Buttons and events'], ['command', 'Commands'], ['action', 'Web API actions'], ['main', 'Program start'], ['test', 'Tests']];
        for (const [kind, heading] of groups) {
          const list = c.members.filter((x) => x.ep === kind).sort((p, q) => (p.ui || p.label).localeCompare(q.ui || q.label));
          if (!list.length) continue;
          out.push(`<div class="group">${heading}</div>`);
          for (const x of list.slice(0, LIST_MAX)) out.push(memberRow(x, 0, x.ui || x.label));
        }
        out.push('<div class="group">All methods</div>');
      }
      for (const ns of c.namespaces) {
        out.push(nsRow(ns));
        if (!codeOpen.has('N:' + ns.key)) continue;
        for (const t of ns.types) {
          out.push(typeRow(t, 1));
          if (calls && codeOpen.has('T:' + t.id)) for (const x of t.m) if (CG.isMethod(x)) out.push(memberRow(x, 2));
        }
      }
      $('files-sub').textContent = calls ? CG.plural(c.methods, 'method') : CG.plural(c.types.length, 'type');
    }
    list.innerHTML = out.join('');
  }

  /** The type, member or namespace a row or details entry stands for. */
  function codeOf(el) {
    const k = el.dataset.k, id = +el.dataset.id;
    return k === 'ns' ? app.code.namespaces[id] : app.code.byId.get(id);
  }

  $('list').addEventListener('click', (e) => {
    const r = e.target.closest('.row[data-id]');
    if (!r) return;
    const onChev = e.target.classList.contains('chev');
    if (!r.dataset.k) {
      const n = app.model.nodes[+r.dataset.id];
      if (n.kids && (onChev || n === app.selected)) {
        if (listOpen.has(n.path)) listOpen.delete(n.path);
        else listOpen.add(n.path);
      }
      return select(n, 'list');
    }
    const x = codeOf(r);
    const toggle = (key) => (codeOpen.has(key) ? codeOpen.delete(key) : codeOpen.add(key));
    if (x.ck === 'ns') {
      if (onChev || x === app.csel) toggle('N:' + x.key);
      if (app.view === 'classes') setScope(scopeNs(x));
      return selectCode(x, 'list');
    }
    if (x.ck === 'type' && app.view === 'calls' && (onChev || x === app.csel)) toggle('T:' + x.id);
    if (x.ck === 'member' && app.view === 'calls') {
      if (app.impact) return startImpact(x);
      app.callFocus = x;
    }
    if (x.ck === 'member' && app.view === 'flow') {
      if (CG.isMethod(x)) requestFlow(x);
      return;
    }
    if (x.ck === 'type' && app.view === 'flow' && (onChev || x === app.csel)) toggle('T:' + x.id);
    selectCode(x, 'list');
  });
  $('list').addEventListener('dblclick', (e) => {
    const r = e.target.closest('.row[data-id]');
    if (!r) return;
    if (!r.dataset.k) {
      const n = app.model.nodes[+r.dataset.id];
      if (n.kids) { if (app.view === 'map') zoomTo(n); }
      else openFile(n);
      return;
    }
    const x = codeOf(r);
    if (x.ck === 'type' && app.view === 'classes') { setScope(scopeType(x)); selectCode(x, 'list'); }
    else if (x.ck !== 'ns') goto(x);
  });

  // ── Details panel ──
  function renderDetails() {
    if (isCode()) return renderCodeDetails();
    const n = app.selected || app.focus || (app.model && app.model.root);
    const title = $('d-title'), body = $('d-body');
    if (!n) { title.textContent = 'Details'; body.innerHTML = ''; return; }
    const m = app.metric;
    title.innerHTML = `<span class="title">${CG.esc(n.name)}</span>`;
    const path = n.parent ? n.path : app.rootPath;
    let h = `<div class="path">${CG.esc(path)}</div>`;
    const types = app.code ? CG.typesUnder(app.code, n) : [];

    if (!n.kids) {
      h += `<div class="stats">
        <span class="k">Language</span><span class="v">${CG.langName(n.lang)}</span>
        <span class="k">Lines</span><span class="v">${n.lines || '<span class="hint">not counted</span>'}</span>
        <span class="k">Size</span><span class="v">${CG.size(n.bytes)}</span>
        ${types.length ? `<span class="k">Types</span><span class="v">${types.length}</span>` : ''}</div>`;
      h += `<div class="btn-row"><button class="btn" data-act="open">Open in editor</button>${types.length ? '<button class="btn" data-act="classes">Show classes</button>' : ''}</div>`;
    } else {
      const folders = n.kids.filter((k) => k.kids).length;
      h += `<div class="stats">
        <span class="k">Files</span><span class="v">${n.files}</span>
        <span class="k">Folders inside</span><span class="v">${folders}</span>
        <span class="k">Lines</span><span class="v">${n.lines}</span>
        <span class="k">Size</span><span class="v">${CG.size(n.bytes)}</span>
        ${types.length ? `<span class="k">C# types</span><span class="v">${types.length}</span>` : ''}</div>`;
      const buttons = [];
      if (app.view === 'map' && n !== app.focus) buttons.push('<button class="btn" data-act="zoom">Show in map</button>');
      if (types.length) buttons.push('<button class="btn" data-act="classes">Show classes</button>');
      if (buttons.length) h += `<div class="btn-row">${buttons.join('')}</div>`;

      const langs = Object.keys(n.langFiles).sort((p, q) => (n.langs[q] || 0) - (n.langs[p] || 0) || n.langFiles[q] - n.langFiles[p]);
      if (langs.length) {
        h += '<div class="heading">Languages</div>';
        for (const g of langs.slice(0, 8)) {
          const lines = n.langs[g] || 0;
          const share = n.lines ? (lines / n.lines) * 100 : 0;
          const what = lines ? `${CG.trim(share, share < 10 ? 1 : 0)} %` : CG.plural(n.langFiles[g], 'file');
          h += `<div class="lang"><span class="dot" style="background:${CG.langColor(g)}"></span><span>${CG.langName(g)}</span><span class="num">${what}</span>` +
            `<span class="meter"><i style="width:${Math.max(share, lines ? 1 : 0)}%;background:${CG.langColor(g)}"></i></span></div>`;
        }
      }

      const files = largest(n, m, 8);
      if (files.length) {
        h += `<div class="heading">Largest files</div>`;
        for (const f of files)
          h += `<div class="top" data-id="${f.id}" title="${CG.esc(f.path)}"><span class="dot" style="background:${CG.langColor(f.lang)}"></span><span class="name">${CG.esc(f.name)}</span><span class="num">${CG.short(f, m)}</span></div>`;
      }
    }
    h += problemsHtml(n);
    body.innerHTML = h;
  }

  /** Hotspots and code with no use found, in a file, a folder, or the whole solution. */
  function problemsHtml(n) {
    if (!app.code) {
      if (!n.parent && app.codeState !== 'analyzing') return '<div class="heading">Problems</div><div class="btn-row"><button class="btn" data-act="read-code">Find hotspots and unused code</button></div>';
      return '';
    }
    const c = app.code;
    const inside = (x) => {
      const f = (x.file || x.f).toLowerCase();
      if (!n.parent) return true;
      return n.kids ? f.startsWith(n.path.toLowerCase() + '/') : f === n.path.toLowerCase();
    };
    let h = '';
    const hot = CG.hotspots(c.members.filter(inside), 8);
    if (hot.length) {
      h += `<div class="heading">${n.parent ? 'Most complex here' : 'Hotspots'}</div>`;
      for (const x of hot)
        h += `<div class="top" data-k="member" data-id="${x.id}" title="${CG.esc(x.label + x.s)} · ${CG.plural(CG.lines(x), 'line')}, nesting ${x.nd || 0}"><span class="cx" style="background:${CG.cxColor(x.cx)}">${x.cx}</span><span class="name">${CG.esc(x.label)}</span><span class="num">${CG.plural(CG.lines(x), 'line')}</span></div>`;
    }
    const types = c.unusedTypes.filter(inside), members = c.unusedMembers.filter((x) => inside(x) && !x.type.unused);
    if (types.length || members.length) {
      h += `<div class="heading">No use found${n.parent ? ' here' : ''}</div>`;
      for (const t of types.slice(0, 8))
        h += `<div class="top" data-k="type" data-id="${t.id}" title="${CG.esc(t.full)}"><span class="dot" style="background:${CG.kindColor(t.k)}"></span><span class="name">${CG.esc(t.n)}</span><span class="num">${t.k}</span></div>`;
      for (const x of members.slice(0, 12))
        h += `<div class="top" data-k="member" data-id="${x.id}" title="${CG.esc(x.label + x.s)}"><span class="glyph-col">${CG.ACCESS[x.a] || ''}</span><span class="name">${CG.esc(x.label)}</span><span class="num">${KIND_NAMES[x.k].toLowerCase()}</span></div>`;
      const rest = types.length + members.length - Math.min(8, types.length) - Math.min(12, members.length);
      if (rest > 0) h += `<div class="hint">${rest} more</div>`;
      h += '<div class="hint" style="margin-top:6px">Nothing in the C# calls or reads these. XAML bindings, reflection or other programs may still use them.</div>';
    }
    return h;
  }

  const KIND_NAMES = { method: 'Method', ctor: 'Constructor', prop: 'Property', field: 'Field', event: 'Event', value: 'Enum value', operator: 'Operator' };
  const codeRow = (x, num, full) => {
    const dot = x.ck === 'type' ? `<span class="dot" style="background:${CG.kindColor(x.k)}"></span>` : `<span class="glyph-col">${CG.ACCESS[x.a] || ''}</span>`;
    const label = x.ck === 'type' ? x.n : full ? x.label : x.k === 'ctor' ? `new ${x.type.n}` : x.n;
    return `<div class="top" data-k="${x.ck}" data-id="${x.id}" title="${CG.esc(x.ck === 'type' ? x.full : x.label + x.s)}">${dot}<span class="name">${CG.esc(label)}</span><span class="num">${num == null ? '' : num}</span></div>`;
  };
  const rows = (heading, list, num, max = 12, full = false) => {
    if (!list.length) return '';
    let h = `<div class="heading">${heading}</div>` + list.slice(0, max).map((x) => codeRow(x, num(x), full)).join('');
    if (list.length > max) h += `<div class="hint">${list.length - max} more</div>`;
    return h;
  };

  function renderFlowDetails() {
    const title = $('d-title'), body = $('d-body'), f = app.flow, e = app.flowEntry, s = app.fsel, c = app.code;
    if (!e) { title.textContent = 'Details'; body.innerHTML = ''; return; }
    const follow = (name, scope, label) =>
      `<button class="chip" data-follow="${CG.esc(name)}" data-scope="${scope}" title="Show where ${CG.esc(name)} goes">${CG.esc(label || 'Follow')}</button>`;
    let h = '';

    // a followed value: every step it passes through, in order
    const tr = app.trace;
    if (tr) {
      h += `<div class="trace"><div class="heading">${CG.esc(tr.title || `Following ${tr.name}`)}</div>`;
      if (tr.exceptions) {
        const un = tr.exceptions.uncaught.length;
        h += un
          ? `<div class="note" style="color:var(--danger)">${CG.plural(un, 'exception')} not caught in this flow${e.ep === 'event' ? `: ${un === 1 ? 'it reaches' : 'they reach'} the event handler and can crash the app unless a global handler catches ${un === 1 ? 'it' : 'them'}` : ''}.</div>`
          : tr.exceptions.throws.length ? '<div class="hint">Every exception thrown in this flow is caught in it.</div>' : '';
      }
      tr.list.forEach((x, i) => {
        const no = x.step.k === 'call' ? x.step.no : '·';
        h += `<div class="top" data-ti="${i}" title="${CG.esc(x.step.f || '')}:${(x.step.l || 0) + 1}"><span class="step-no">${no}</span>` +
          `<span class="name">${CG.esc(CG.flowLabel(x.step))}</span><span class="num">${CG.esc(x.role)}</span></div>`;
      });
      if (!tr.list.length) h += '<div class="hint">It is not used again in this flow.</div>';
      h += '<div class="btn-row"><button class="btn" data-act="stop-trace">Stop following</button></div></div>';
    }

    if (!s || s === (f && f.data && f.data.root)) {
      title.innerHTML = `<span class="title">${CG.esc(e.ui || e.label)}</span>`;
      h += `<div class="path">${CG.esc(e.ui ? e.label : e.type.full)}</div><div class="sig">${CG.esc(`${e.a} ${e.n}${e.s}`)}</div>`;
      if (f && f.state === 'ready')
        h += `<div class="stats"><span class="k">Calls</span><span class="v">${f.data.calls}</span><span class="k">Classes</span><span class="v">${f.data.classes}</span></div>`;
      h += '<div class="btn-row"><button class="btn" data-act="goto-entry">Go to code</button><button class="btn" data-act="open-all">Open all</button><button class="btn" data-act="close-all">Close all</button></div>';
      if (e.pn && e.pn.length && e.ep !== 'event' && f && f.state === 'ready') {
        h += '<div class="heading">Goes in</div>';
        for (const p of e.pn) h += `<div class="io"><span class="name">${CG.esc(p)}</span>${follow(p, 1)}</div>`;
      }
      if (f && f.state === 'ready') {
        const outs = CG.flowOutputs(f.data, c);
        if (outs.length) {
          h += '<div class="heading">What it produces</div>';
          for (const o of outs) {
            const by = o.from === f.data.root ? 'returned' : `from ${o.from.no}. ${CG.flowLabel(o.from)}`;
            const into = o.from.v && o.from.v !== 'return' ? follow(o.from.v, CG.enclosing(o.from) ? CG.enclosing(o.from).no : 1, `Follow ${o.from.v}`) : '';
            h += `<div class="io"><span class="hint">${CG.esc(by)}</span>${into}</div><div class="shape">${CG.shapeHtml(c, o.type.n)}</div>`;
          }
        }
      }
      if (f && f.state === 'ready' && !tr) {
        const ex = CG.exceptionMap(f.data);
        if (ex.throws.length) {
          h += `<div class="heading">Exceptions</div><div class="io"><span class="name">${CG.plural(ex.throws.length, 'throw')}</span>` +
            `${ex.uncaught.length ? `<span class="hint" style="color:var(--danger)">${ex.uncaught.length} not caught</span>` : '<span class="hint">all caught</span>'}<button class="chip" data-act="exceptions">Show</button></div>`;
        }
      }
      if (!tr) h += '<div class="heading">Reading the flow</div><div class="hint">Calls are numbered in the order they run; each shows what goes in and, after the arrow, where its result goes. Double-click a call to open or close it. Follow a value to see every step it passes through.</div>';
    } else if (s.k === 'call') {
      const m = s.member, scope = CG.enclosing(s);
      title.innerHTML = `<span class="title">${s.no}. ${CG.esc(CG.flowLabel(s))}</span>`;
      h += `<div class="path">${CG.esc(m ? m.type.full : 'outside the solution')}</div>`;
      if (m) h += `<div class="sig">${CG.esc(`${s.aw ? 'await ' : ''}${m.a}${m.st ? ' static' : ''} ${m.n}${m.s}`)}</div>`;
      h += `<div class="stats"><span class="k">Called at</span><span class="v">${CG.esc(s.f.split('/').pop())}:${s.l + 1}</span>`;
      if (s.b && s.b.length) h += `<span class="k">Can run</span><span class="v">${CG.plural(s.b.length, 'implementation')}</span>`;
      h += '</div>';
      const why = { seen: 'This method was already followed earlier in the flow.', recursion: 'This method calls itself here, so the flow stops.', depth: 'The flow is too deep here to follow further.', budget: 'The flow is too long; it stops here.' };
      if (s.x) h += `<div class="hint" style="margin-top:8px">${why[s.x]}</div>`;
      const buttons = ['<button class="btn" data-act="goto-step">Go to call</button>'];
      if (m) buttons.push('<button class="btn" data-act="goto-member">Go to method</button>');
      if (CG.canOpen(s)) buttons.push(`<button class="btn" data-act="toggle">${s.open ? 'Close' : 'Open'}</button>`);
      if (m && CG.isMethod(m) && s.parent) buttons.push('<button class="btn" data-act="start-here">Start here</button>');
      h += `<div class="btn-row">${buttons.join('')}</div>`;

      // what goes in: the object it runs on, each argument, and the parameter it becomes inside the method
      if ((s.a && s.a.length) || s.on) h += '<div class="heading">Goes in</div>';
      if (s.on) {
        const target = CG.followable(s.on);
        h += `<div class="io"><span class="name" title="${CG.esc(s.on)}">${CG.esc(s.on)}</span><span class="hint">runs on it</span>${target && scope ? follow(target, scope.no) : ''}</div>`;
      }
      if (s.a && s.a.length) {
        s.a.forEach((arg, i) => {
          const p = m && m.pn && m.pn[i];
          const name = CG.followable(arg);
          h += `<div class="io"><span class="name" title="${CG.esc(arg)}">${CG.esc(arg)}</span>${p ? `<span class="hint">as ${CG.esc(p)}</span>` : ''}${name && scope ? follow(name, scope.no) : ''}</div>`;
        });
      }
      // what comes out: the type, where it is stored, what the method returns, and the type's shape
      const type = CG.stepType(s);
      if (type || s.v || s.rv) {
        h += '<div class="heading">Comes out</div>';
        if (type) h += `<div class="io"><span class="name">${CG.esc(type)}</span></div>`;
        if (s.rv) h += `<div class="io"><span class="hint">returns ${CG.esc(s.rv.join(' or '))}</span></div>`;
        if (s.v === 'return') h += '<div class="io"><span class="hint">and is returned straight away</span></div>';
        else if (s.v) h += `<div class="io"><span class="hint">stored in</span><span class="name">${CG.esc(s.v)}</span>${scope ? follow(s.v, scope.no) : ''}</div>`;
        const shape = type ? CG.shapeHtml(c, type) : '';
        if (shape) h += `<div class="shape">${shape}</div>`;
      }
    } else {
      const names = { if: 'Decision', switch: 'Decision', loop: 'Loop', try: 'Error handling', return: 'Returns early', throw: 'Throws' };
      title.innerHTML = `<span class="title">${names[s.k]}</span>`;
      h += `<div class="sig">${CG.esc(CG.flowLabel(s))}</div>`;
      h += `<div class="stats"><span class="k">Line</span><span class="v">${CG.esc(s.f.split('/').pop())}:${s.l + 1}</span></div>`;
      if (s.b) h += '<div class="heading">Ways it can go</div>' + s.b.map((b) => `<div class="top"><span class="name">${CG.esc(b.c)}</span><span class="num">${b.s.length ? CG.plural(b.s.length, 'step') : 'nothing'}</span></div>`).join('');
      h += '<div class="btn-row"><button class="btn" data-act="goto-step">Go to code</button></div>';
    }
    body.innerHTML = h;
  }

  /** Shows every step a value passes through, opening the calls on the way so they can be seen. */
  function startTrace(scope, name) {
    const f = app.flow;
    if (!f || f.state !== 'ready' || !scope) return;
    const roles = CG.traceValue(scope, name);
    for (const step of roles.keys())
      for (let p = step.parent; p; p = p.parent) if (CG.canOpen(p)) p.open = true;
    const list = [];
    const visit = (st) => {
      if (roles.has(st)) list.push({ step: st, role: roles.get(st) });
      (st.s || []).forEach(visit);
      (st.b || []).forEach((b) => b.s.forEach(visit));
    };
    visit(f.data.root);
    app.trace = { name, roles, list };
    app.flowVersion++;
    renderDetails();
    redraw();
  }

  function stopTrace() {
    app.trace = null;
    app.flowVersion++;
    renderDetails();
    redraw();
  }

  function renderImpactDetails() {
    const title = $('d-title'), body = $('d-body'), im = app.impact, x = im.target;
    title.innerHTML = `<span class="title">Impact of ${CG.esc(x.ck === 'type' ? x.n : x.label)}</span>`;
    let h = `<div class="path">${CG.esc(x.ck === 'type' ? x.full : x.type.full)}</div>`;
    h += `<div class="stats"><span class="k">Methods reached</span><span class="v">${im.affected.length}</span><span class="k">Classes</span><span class="v">${im.types.size}</span><span class="k">Starting points</span><span class="v">${im.entries.length}</span></div>`;
    h += '<div class="btn-row"><button class="btn" data-act="back-calls">Back to calls</button></div>';
    if (im.entries.length) {
      h += '<div class="heading">Where a change shows up</div>';
      for (const e of im.entries)
        h += `<div class="io"><span class="name" title="${CG.esc(e.label)}">${CG.esc(e.ui || e.label)}</span><button class="chip" data-act="flow-from" data-id="${e.id}">Open flow</button></div>`;
    }
    if (im.dependents.length) h += rows('Types that depend on it', im.dependents, (t) => t.k, 16);
    const byDistance = im.affected.slice().sort((p, q) => im.reached.get(p) - im.reached.get(q));
    h += rows('Methods reached', byDistance, (m) => CG.plural(im.reached.get(m), 'step'), 20, true);
    if (!im.affected.length) h += '<div class="hint" style="margin-top:8px">Nothing in the C# uses this, so a change stays here.</div>';
    body.innerHTML = h;
  }

  function renderCodeDetails() {
    if (app.view === 'flow') return renderFlowDetails();
    if (app.view === 'calls' && app.impact && !app.csel) return renderImpactDetails();
    const title = $('d-title'), body = $('d-body'), c = app.code;
    const x = app.csel || (app.view === 'calls' ? app.callFocus : app.scope && (app.scope.ns || app.scope.type));
    if (!c || !x) { title.textContent = 'Details'; body.innerHTML = ''; return; }
    let h = '';
    if (x.ck === 'ns') {
      title.innerHTML = `<span class="title">${CG.esc(x.name)}</span>`;
      const kinds = {};
      for (const t of x.types) kinds[t.k] = (kinds[t.k] || 0) + 1;
      h += `<div class="path">Namespace</div><div class="stats"><span class="k">Types</span><span class="v">${x.types.length}</span>` +
        Object.keys(kinds).sort().map((k) => `<span class="k">${k[0].toUpperCase() + k.slice(1)}</span><span class="v">${kinds[k]}</span>`).join('') + '</div>';
      if (app.view === 'classes' && !(app.scope && app.scope.ns === x)) h += '<div class="btn-row"><button class="btn" data-act="ns">Show namespace</button></div>';
      h += rows('Types', x.types, (t) => t.m.length, 40);
    } else if (x.ck === 'type') {
      title.innerHTML = `<span class="title">${CG.esc(x.n)}</span>`;
      const get = (id) => c.byId.get(id);
      const base = x.b != null && get(x.b);
      h += `<div class="path">${CG.esc(x.ns || 'global namespace')} · ${CG.esc(x.p)}</div><div class="stats">
        <span class="k">Kind</span><span class="v">${CG.esc((x.mod ? x.mod + ' ' : '') + x.k)}</span>
        <span class="k">Access</span><span class="v">${x.a}</span>
        <span class="k">Members</span><span class="v">${x.m.length}</span>
        <span class="k">Used by</span><span class="v">${x.usedBy.length}</span></div>`;
      const buttons = ['<button class="btn" data-act="goto">Go to code</button>'];
      if (app.view !== 'classes' || !(app.scope && app.scope.type === x)) buttons.push('<button class="btn" data-act="relations">Relations</button>');
      if (x.m.some(CG.isMethod)) buttons.push('<button class="btn" data-act="calls">Call graph</button>');
      buttons.push('<button class="btn" data-act="impact">Impact</button>');
      if (x.unused) h += '<div class="note">No use found: nothing in the C# names, creates or calls this type.</div>';
      h += `<div class="btn-row">${buttons.join('')}</div>`;
      h += rows('Inherits from', base ? [base] : [], () => '');
      h += rows('Implements', x.i.map(get).filter(Boolean), () => '');
      h += rows('Members', x.m, (m) => KIND_NAMES[m.k].toLowerCase(), 40);
      h += rows(x.k === 'interface' ? 'Implemented by' : 'Derived types', [...x.derived, ...x.implementors], () => '');
      h += rows('Used by', x.usedBy, () => '');
    } else {
      const t = x.type;
      title.innerHTML = `<span class="title">${CG.esc(x.k === 'ctor' ? 'new ' + t.n : x.n)}</span>`;
      h += `<div class="path">${CG.esc(t.full)}</div>`;
      h += `<div class="sig">${CG.esc(`${x.a}${x.st ? ' static' : ''}${x.abs ? ' abstract' : ''} ${x.n}${x.s}`)}</div>`;
      h += `<div class="stats"><span class="k">Kind</span><span class="v">${KIND_NAMES[x.k]}</span>`;
      if (CG.isMethod(x)) h += `<span class="k">Called by</span><span class="v">${x.in.size}</span><span class="k">Calls</span><span class="v">${x.out.size}</span>`;
      if (x.refIn.size) h += `<span class="k">Used by</span><span class="v">${x.refIn.size}</span>`;
      if (x.cx) h += `<span class="k">Complexity</span><span class="v"><span class="cx" style="background:${CG.cxColor(x.cx)}">${x.cx}</span></span><span class="k">Lines</span><span class="v">${CG.lines(x)}</span><span class="k">Deepest nesting</span><span class="v">${x.nd || 0}</span>`;
      h += '</div>';
      if (x.unused) h += '<div class="note">No use found: nothing in the C# calls or reads this.</div>';
      if (x.cx > 10) h += `<div class="hint" style="margin-top:6px">${x.cx} paths run through this ${KIND_NAMES[x.k].toLowerCase()}. Splitting it into smaller methods makes it easier to test and change.</div>`;
      const buttons = ['<button class="btn" data-act="goto">Go to code</button>'];
      if (CG.isMethod(x) && !(app.view === 'calls' && app.callFocus === x && !app.impact)) buttons.push('<button class="btn" data-act="calls">Call graph</button>');
      buttons.push('<button class="btn" data-act="impact">Impact</button>');
      h += `<div class="btn-row">${buttons.join('')}</div>`;
      const sites = (map) => (m) => (map.get(m) > 1 ? `×${map.get(m)}` : '');
      h += rows('Called by', [...x.in.keys()].sort((p, q) => p.label.localeCompare(q.label)), sites(x.in), 20, true);
      h += rows('Calls', [...x.out.keys()].sort((p, q) => p.label.localeCompare(q.label)), sites(x.out), 20, true);
      h += rows('Used by', [...x.refIn.keys()].sort((p, q) => p.label.localeCompare(q.label)), () => '', 20, true);
      if (x.implements.length) h += rows('Implements', x.implements, () => '', 8, true);
      if (x.implementedBy.length) h += rows('Implemented by', x.implementedBy, () => '', 8, true);
    }
    body.innerHTML = h;
  }

  /** The `count` largest files under `folder` by the measure. */
  function largest(folder, m, count) {
    const best = [];
    const stack = [folder];
    while (stack.length) {
      const n = stack.pop();
      if (n.kids) { for (const k of n.kids) stack.push(k); continue; }
      const v = CG.value(n, m);
      if (v <= 0 || (best.length === count && v <= CG.value(best[count - 1], m))) continue;
      best.push(n);
      best.sort((p, q) => CG.value(q, m) - CG.value(p, m));
      if (best.length > count) best.pop();
    }
    return best;
  }

  $('d-body').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (app.view === 'flow') {
        const s = app.fsel;
        if (a === 'stop-trace') stopTrace();
        if (a === 'exceptions') showExceptions();
        if (a === 'goto-entry') goto(app.flowEntry);
        if (a === 'open-all') setAllOpen(true);
        if (a === 'close-all') setAllOpen(false);
        if (a === 'goto-step') gotoStep(s);
        if (a === 'goto-member' && s && s.member) goto(s.member);
        if (a === 'toggle' && s) toggleStep(s);
        if (a === 'start-here' && s && s.member) requestFlow(s.member);
      } else if (isCode()) {
        const x = app.csel || (app.view === 'calls' ? app.callFocus : app.scope && (app.scope.ns || app.scope.type));
        if (a === 'goto') goto(x);
        if (a === 'relations') { setScope(scopeType(x)); app.view === 'classes' ? selectCode(x, 'details') : switchView('classes'); }
        if (a === 'ns') { setScope(scopeNs(x)); selectCode(x, 'details'); }
        if (a === 'calls') focusCalls(x.ck === 'type' ? CG.busiest(x.m) : x);
        if (a === 'impact') startImpact(x);
        if (a === 'back-calls') stopImpact();
        if (a === 'flow-from') {
          const entry = app.code.byId.get(+act.dataset.id);
          switchView('flow');
          requestFlow(entry);
        }
      } else {
        const n = app.selected || app.focus;
        if (a === 'open') openFile(n);
        if (a === 'read-code') ensureCode(true);
        if (a === 'zoom') zoomTo(n);
        if (a === 'classes') {
          setScope(scopeFiles(n, CG.typesUnder(app.code, n)));
          app.csel = null;
          switchView('classes');
          document.querySelectorAll('#view button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'classes'));
        }
      }
      return;
    }
    const chip = e.target.closest('[data-follow]');
    if (chip && app.flow && app.flow.data) return startTrace(app.flow.data.byNo.get(+chip.dataset.scope), chip.dataset.follow);
    const traced = e.target.closest('[data-ti]');
    if (traced && app.trace) return selectStep(app.trace.list[+traced.dataset.ti].step, 'details');
    const top = e.target.closest('.top[data-id]');
    if (!top) return;
    if (top.dataset.k) {
      const x = codeOf(top);
      if (!isCode()) switchView('classes');
      selectCode(x, 'details');
    } else select(app.model.nodes[+top.dataset.id], 'details');
  });
  $('d-body').addEventListener('dblclick', (e) => {
    // a field or type in a result's shape opens its declaration
    const part = e.target.closest('.shape [data-k]');
    if (part && app.code) return goto(app.code.byId.get(+part.dataset.id));
    const top = e.target.closest('.top[data-id]');
    if (!top) return;
    if (!top.dataset.k) return openFile(app.model.nodes[+top.dataset.id]);
    const x = codeOf(top);
    if (app.view === 'calls' && x.ck === 'member' && CG.isMethod(x)) focusCalls(x);
    else goto(x);
  });

  // ── search ──
  function search() {
    const q = $('search').value.trim().toLowerCase();
    if (!q || !app.model) { app.matches = null; return; }
    const set = new Set();
    for (const n of app.model.nodes) {
      if (n.kids || !n.path.toLowerCase().includes(q)) continue;
      for (let p = n; p && !set.has(p.id); p = p.parent) set.add(p.id);
    }
    app.matches = set;
  }
  function codeSearch() {
    const q = $('search').value.trim().toLowerCase();
    if (!q || !app.code) { app.codeMatches = null; return; }
    const set = new Set();
    for (const t of app.code.types) if (t.n.toLowerCase().includes(q)) set.add(t.id);
    for (const x of app.code.members)
      if (x.n.toLowerCase().includes(q) || x.label.toLowerCase().includes(q)) {
        set.add(x.id);
        set.add(x.type.id);
      }
    app.codeMatches = set;
  }
  $('search').addEventListener('input', () => {
    search();
    codeSearch();
    renderList();
    redraw();
  });

  // ── canvas input ──
  let down = null, dragged = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY };
    dragged = false;
    canvas.setPointerCapture(e.pointerId);
    hideTip();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (down) {
      if (!dragged && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) dragged = true;
      if (dragged && canPan()) {
        view().pan(e.clientX - down.lx, e.clientY - down.ly);
        canvas.style.cursor = 'grabbing';
        redraw();
      }
      down.lx = e.clientX;
      down.ly = e.clientY;
      return;
    }
    if (!$('empty').hidden || (isCode() ? !app.code : !app.model)) return;
    const n = view().hit(e.clientX, e.clientY);
    if (n !== app.hover) { app.hover = n; redraw(); }
    showTip(n, e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerup', () => { down = null; canvas.style.cursor = ''; });
  canvas.addEventListener('pointerleave', () => {
    if (down) return;
    app.hover = null;
    hideTip();
    redraw();
  });
  canvas.addEventListener('click', (e) => {
    if (dragged) { dragged = false; return; }
    if (e.detail > 1 || !$('empty').hidden) return;
    const n = view().hit(e.clientX, e.clientY);
    if (app.view === 'flow') return selectStep(n, 'canvas');
    if (isCode()) return app.code && selectCode(n, 'canvas');
    if (!app.model) return;
    if (app.view === 'tree' && n && n.kids) views.tree.toggle(n);
    select(n, 'canvas');
  });
  canvas.addEventListener('dblclick', (e) => {
    if (!$('empty').hidden) return;
    const n = view().hit(e.clientX, e.clientY);
    if (!n) return;
    if (app.view === 'flow') {
      if (!toggleStep(n)) gotoStep(n);
    } else if (app.view === 'classes') {
      if (n.ck === 'type') { setScope(scopeType(n)); selectCode(n, 'canvas'); }
      else goto(n);
    } else if (app.view === 'calls') focusCalls(n);
    else if (!n.kids) openFile(n);
    else if (app.view === 'map') zoomTo(n);
  });
  canvas.addEventListener('wheel', (e) => {
    if (!canPan()) return;
    e.preventDefault();
    view().zoom(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    hideTip();
    redraw();
  }, { passive: false });

  // ── tooltip ──
  const tip = $('tip');
  function showTip(n, x, y) {
    if (!n) return hideTip();
    let lines;
    if (app.view === 'flow') {
      if (n.k === 'call') lines = [`${n.no}. ${CG.flowLabel(n)}`, n.member ? n.member.s || KIND_NAMES[n.member.k] : 'outside the solution', `${n.f.split('/').pop()}:${n.l + 1}${CG.canOpen(n) ? ' · double-click to ' + (n.open ? 'close' : 'open') : ''}`];
      else lines = [CG.flowLabel(n), n.b ? n.b.map((b) => b.c).join(' · ') : n.k, `${n.f.split('/').pop()}:${n.l + 1}`];
    } else if (n.ck === 'type') lines = [n.n, `${n.mod ? n.mod + ' ' : ''}${n.k} in ${n.ns || 'the global namespace'}`, CG.plural(n.m.length, 'member')];
    else if (n.ck === 'member') lines = [n.label, n.s || KIND_NAMES[n.k], CG.isMethod(n) ? `called by ${n.in.size} · calls ${n.out.size}` : KIND_NAMES[n.k]];
    else lines = [n.name, n.parent && n.parent.path ? n.parent.path : app.model.root.name,
      [n.kids ? CG.plural(n.files, 'file') : CG.langName(n.lang), CG.plural(n.lines, 'line'), CG.size(n.bytes)].join(' · ')];
    tip.innerHTML = `<div class="t">${CG.esc(lines[0])}</div><div class="s">${CG.esc(lines[1])}</div><div class="s">${CG.esc(lines[2])}</div>`;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(x + 14, innerWidth - w - 8) + 'px';
    tip.style.top = (y + 18 + h > innerHeight - 8 ? y - h - 10 : y + 18) + 'px';
  }
  function hideTip() { tip.hidden = true; }

  // ── bar ──
  function segmented(id, value, pick) {
    const el = $(id);
    const mark = (v) => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
    mark(value);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      mark(b.dataset.v);
      pick(b.dataset.v);
    });
  }
  segmented('view', app.view, switchView);
  segmented('metric', app.metric, (v) => {
    app.metric = settings.metric = v;
    save();
    renderAll();
  });
  segmented('members', app.membersMode, (v) => {
    app.membersMode = settings.members = v;
    save();
    redraw();
  });
  segmented('colorby', app.colorBy, (v) => {
    app.colorBy = settings.colorBy = v;
    save();
    if (v === 'complexity') ensureCode(true);
    statusLine();
    redraw();
  });
  $('exc-toggle').addEventListener('click', () => {
    if (app.trace && app.trace.name === 'exceptions') stopTrace();
    else showExceptions();
    layout();
  });
  const exportPop = $('export-pop');
  $('export').addEventListener('click', (e) => {
    e.stopPropagation();
    exportPop.hidden = !exportPop.hidden;
    exportPop.style.right = innerWidth - $('export').getBoundingClientRect().right + 'px';
    $('export-what').textContent = exportName().replace(/^Codesight /, '');
    const mermaid = app.view !== 'map' || !!app.model;
    $('export-mm-copy').disabled = $('export-mm-save').disabled = !mermaid;
  });
  exportPop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-export]');
    if (b) exportAs(b.dataset.export);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!exportPop.hidden && !exportPop.contains(e.target) && e.target !== $('export')) exportPop.hidden = true;
  });
  segmented('flowstyle', app.flowStyle, (v) => {
    app.flowStyle = settings.flowStyle = v;
    save();
    redraw();
  });
  segmented('depth', app.depth, (v) => {
    app.depth = settings.depth = +v;
    save();
    redraw();
  });
  $('toggle-files').addEventListener('click', () => { settings.files = !settings.files; save(); layout(); });
  $('toggle-details').addEventListener('click', () => { settings.details = !settings.details; save(); layout(); });
  $('fit').addEventListener('click', () => {
    if (app.view === 'map') { if (app.model) zoomTo(app.model.root); }
    else view().fit(ctx);
    redraw();
  });
  $('rescan').addEventListener('click', () => {
    if (app.view === 'flow' && app.flowEntry && app.code) requestFlow(app.flowEntry);
    else if (isCode()) {
      if (host) send({ type: 'analyze' });
      else onHost(CG.sampleCode());
    } else if (host) send({ type: 'rescan' });
    else onHost(demo());
  });

  // ── settings ──
  const pop = $('settings');
  $('open-settings').addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $('open-settings')) pop.hidden = true;
  });
  segmented('set-theme', settings.theme, (v) => { settings.theme = v; save(); applyTheme(); });
  segmented('set-material', settings.material, (v) => { settings.material = v; save(); applyTheme(); });
  const alpha = $('set-alpha');
  const showAlpha = () => {
    alpha.style.setProperty('--p', ((alpha.value - alpha.min) / (alpha.max - alpha.min)) * 100 + '%');
    $('alpha-value').textContent = alpha.value + ' %';
  };
  alpha.value = Math.round(settings.alpha * 100);
  showAlpha();
  alpha.addEventListener('input', () => {
    settings.alpha = alpha.value / 100;
    showAlpha();
    document.documentElement.style.setProperty('--glass', settings.alpha);
  });
  alpha.addEventListener('change', save);
  $('set-follow').checked = settings.follow;
  $('set-follow').addEventListener('change', () => { settings.follow = $('set-follow').checked; save(); });

  // ── keyboard ──
  document.addEventListener('keydown', (e) => {
    const typing = e.target === $('search');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
      $('search').select();
    } else if (e.key === 'Escape') {
      if (!pop.hidden) pop.hidden = true;
      else if (!exportPop.hidden) exportPop.hidden = true;
      else if (app.view === 'calls' && app.impact) stopImpact();
      else if ($('search').value) { $('search').value = ''; search(); codeSearch(); renderList(); redraw(); }
      else if (app.view === 'flow' && app.trace) stopTrace();
      else if (app.view === 'flow' && app.fsel) selectStep(null, 'key');
      else if (isCode() && app.csel) selectCode(null, 'key');
      else if (!isCode() && app.selected) select(null, 'key');
    } else if (!typing && e.key === 'Backspace' && app.view === 'map' && app.focus && app.focus.parent) {
      zoomTo(app.focus.parent);
    } else if (!typing && e.key === 'Enter') {
      if (app.view === 'flow') gotoStep(app.fsel);
      else if (isCode()) goto(app.csel);
      else if (app.selected) app.selected.kids ? zoomTo(app.selected) : openFile(app.selected);
    }
  });

  function renderAll() {
    refreshEmpty();
    renderCrumbs();
    layout();
    renderList();
    renderDetails();
    statusLine();
    redraw();
  }

  addEventListener('resize', layout);
  // labels are measured in Inter: measure again once it has loaded
  document.fonts.addEventListener('loadingdone', () => {
    views.tree.modelChanged();
    views.classes.key = views.calls.key = '';
    redraw();
  });

  // ── start ──
  function demo() {
    const tree = CG.sample();
    let files = 0;
    const count = (r) => (r.k ? r.k.forEach(count) : files++);
    count(tree);
    return { type: 'tree', root: 'C:\\Code\\Contoso', name: 'Contoso', tree, files, truncated: false, maxFiles: 200000, seconds: 0.18 };
  }

  applyTheme();
  renderAll();
  if (host) {
    host.addEventListener('message', (e) => onHost(e.data));
    send({ type: 'ready' });
  } else {
    // a plain browser: show a made-up project so the page can be worked on without Visual Studio
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { hostDark = e.matches; applyTheme(); });
    document.fonts.ready.then(() => onHost(demo()));
  }
})();
