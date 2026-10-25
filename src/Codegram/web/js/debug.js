'use strict';
// Debugger snapshot: when Visual Studio pauses, the extension sends the paused thread's call stack (innermost frame
// first) with each frame's file, line, arguments and locals. These helpers tie the frames to the code model and to
// the steps of a flow, so the views can show the live path and real values.

/** Each frame's member in the code model, when the frame is in the solution's code. */
CG.matchFrames = function (code, frames) {
  for (const f of frames) f.member = f.mine && f.file && code ? CG.memberAt(code, f.file, f.line) : null;
  return frames;
};

/** The members on the paused stack, for the small markers in the Calls and Classes views. */
CG.liveMembers = (frames) => new Set(frames.filter((f) => f.member).map((f) => f.member));

/** Where a flow could start for this pause: the outermost frame of the solution that is an entry point, or else the outermost one. */
CG.pauseEntry = function (frames) {
  const mine = frames.filter((f) => f.member && CG.isMethod(f.member));
  for (let i = mine.length - 1; i >= 0; i--) if (mine[i].member.ep) return mine[i].member;
  return mine.length ? mine[mine.length - 1].member : null;
};

/**
 * The live path through a flow: from the frame that is the flow's starting method inwards, the call step for each
 * next frame (found among the steps of the method around it, not inside other calls), and the step the innermost
 * known frame is paused at. Opens the calls on the way. Null when the flow's start is not on the stack.
 */
CG.liveInFlow = function (data, frames) {
  const mine = frames.filter((f) => f.member).slice().reverse(); // outermost first
  const start = mine.findIndex((f) => f.member === data.entry);
  if (start < 0) return null;
  const roles = new Map(), frameOf = new Map();
  let scope = data.root, body = scope.s || [];
  roles.set(scope, 'running');
  frameOf.set(scope, mine[start]);
  // a call among a method's own steps (inside its decisions and loops, but not inside other calls)
  const direct = (list, test) => {
    for (const s of list || []) {
      if (s.k === 'call') { if (test(s)) return s; continue; }
      const inner = direct(s.s, test) || (s.b || []).reduce((found, b) => found || direct(b.s, test), null);
      if (inner) return inner;
    }
    return null;
  };
  let i = start + 1;
  for (; i < mine.length; i++) {
    const f = mine[i];
    const call = direct(body, (s) => s.member === f.member || (s.b || []).some((b) => b.member === f.member));
    if (!call) break;
    roles.set(call, 'running');
    frameOf.set(call, f);
    for (let p = call.parent; p; p = p.parent) if (CG.canOpen(p)) p.open = true;
    if (CG.canOpen(call)) call.open = true;
    const branch = (call.b || []).find((b) => b.member === f.member);
    scope = call;
    body = branch ? branch.s : call.s || [];
    // the flow did not follow this call further (shown earlier, too deep): the path ends here
    if (call.x) { i++; break; }
  }
  const last = mine[i - 1];
  // the step on the paused line, or the last one before it
  let here = null;
  const visit = (list) => {
    for (const s of list || []) {
      if (s.l != null && s.l <= last.line && (!here || s.l >= here.l)) here = s;
      if (s.k !== 'call') { visit(s.s); (s.b || []).forEach((b) => visit(b.s)); }
    }
  };
  visit(body);
  if (here) {
    for (let p = here.parent; p; p = p.parent) if (CG.canOpen(p)) p.open = true;
    if (!roles.has(here)) roles.set(here, 'paused here');
  } else roles.set(scope, 'paused in here');
  return { roles, frameOf, here, scope, last, complete: i >= mine.length };
};

/** Made-up members of a value, for opening values in the browser demo. */
CG.sampleChildren = function (path) {
  const v = (n, t, val, kids) => ({ n, t, v: val, kids: !!kids });
  const last = path[path.length - 1];
  if (last === 'products') return [v('[0]', 'Product', '{Keyboard}', true), v('[1]', 'Product', '{Mouse}', true), v('[2]', 'Product', '{Monitor}', true), v('Count', 'int', '3')];
  if (/price|Price|Total/.test(last)) return [v('Amount', 'decimal', '19.99'), v('Currency', 'string', '"EUR"')];
  if (/customer/i.test(last)) return [v('Name', 'string', '"Ada Lovelace"'), v('Email', 'string', '"ada@example.com"'), v('Address', 'Address', '{Address}', true)];
  if (/order|this/i.test(last)) return [v('Customer', 'Customer', '{Contoso.Api.Models.Customer}', true), v('Status', 'OrderStatus', 'Draft'), v('Total', 'Money', '{39.98 EUR}', true), v('lines', 'List<OrderLine>', 'Count = 2', true)];
  return [v('Sku', 'string', '"KB-01"'), v('Name', 'string', '"Keyboard"'), v('Price', 'Money', '{19.99 EUR}', true)];
};

/** A made-up pause in the made-up sample, for the browser demo: inside Order.AddLine, called from the Place order button. */
CG.sampleDebug = function (code) {
  const find = (label) => code.members.find((x) => x.label === label);
  const addLine = find('Order.AddLine'), place = find('OrderService.Place'), click = find('MainWindow.PlaceOrderButton_Click');
  const v = (n, t, val, kids) => ({ n, t, v: val, kids: !!kids });
  return {
    type: 'debug', state: 'break', id: 1, reason: 'Breakpoint', thread: 'Main Thread',
    frames: [
      { index: 0, fn: 'Contoso.Api.Models.Order.AddLine', file: addLine.file, line: addLine.l + 3, mine: true,
        args: [v('product', 'Product', '{Contoso.Api.Models.Product}', true), v('quantity', 'int', '1')],
        locals: [v('this', 'Order', '{Contoso.Api.Models.Order}', true), v('line', 'OrderLine', 'null')] },
      { index: 1, fn: 'Contoso.Api.Services.OrderService.Place', file: place.file, line: place.l + 3, mine: true,
        args: [v('customer', 'Customer', '{Contoso.Api.Models.Customer}', true), v('products', 'List<Product>', 'Count = 3', true)],
        locals: [v('order', 'Order', '{Contoso.Api.Models.Order}', true), v('product', 'Product', '{Contoso.Api.Models.Product}', true), v('price', 'Money', '{19.99 EUR}', true)] },
      { index: 2, fn: 'Contoso.Desktop.MainWindow.PlaceOrderButton_Click', file: click.file, line: click.l + 2 + 2, mine: true,
        args: [v('sender', 'object', '{System.Windows.Controls.Button: Place order}', true), v('e', 'RoutedEventArgs', '{System.Windows.RoutedEventArgs}', true)],
        locals: [v('order', 'Order', 'null')] },
      { index: 3, fn: 'PresentationFramework.dll!System.Windows.Controls.Button.OnClick()', file: null, line: -1, mine: false },
      { index: 4, fn: 'WindowsBase.dll!System.Windows.Threading.Dispatcher.Run()', file: null, line: -1, mine: false },
    ],
  };
};
