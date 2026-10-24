'use strict';
// A made-up flow in the shape FlowAnalyzer.cs sends, built from the made-up C# model in sample-code.js.
CG.sampleFlow = function (code, entry) {
  const expanded = new Set([entry]), active = new Set([entry]);
  const named = (m, n) => [...m.out.keys()].find((x) => x.n === n || x.label === n);
  const at = (m, i) => ({ f: m.file, l: m.l + 2 + i });

  const follow = (m, s) => {
    if (active.has(m)) { s.x = 'recursion'; return null; }
    if (expanded.has(m)) { s.x = 'seen'; return null; }
    expanded.add(m);
    active.add(m);
    const steps = body(m);
    active.delete(m);
    return steps;
  };

  const call = (callee, caller, i, extra = {}) => {
    const s = { k: 'call', m: callee.id, ...at(caller, i), ...extra };
    if (callee.type.k === 'interface') {
      const impls = callee.type.implementors.map((t) => t.m.find((x) => x.n === callee.n)).filter(Boolean);
      if (impls.length) {
        s.b = impls.map((x) => ({ c: x.type.n, m: x.id, s: follow(x, s) || [] }));
        return s;
      }
    }
    const steps = follow(callee, s);
    if (steps && steps.length) s.s = steps;
    return s;
  };

  // a few methods shaped like real code, with a guard, a loop and a try; the rest call in order
  const body = (m) => {
    if (m.label === 'MainWindow.PlaceOrderButton_Click') {
      return [{
        k: 'try', c: 'try', ...at(m, 1),
        b: [
          { c: 'try', s: [call(named(m, 'Place'), m, 2, { aw: true })] },
          { c: 'catch InvalidOperationException', s: [call(named(m, 'ShowError'), m, 6)] },
        ],
      }];
    }
    if (m.label === 'OrderService.Place') {
      return [
        call(named(m, 'NotNull'), m, 1),
        { k: 'if', c: 'products.Count == 0', ...at(m, 2), b: [{ c: 'yes', s: [{ k: 'throw', c: 'new ArgumentException("An order needs products")', ...at(m, 3) }] }, { c: 'no', s: [] }] },
        call(named(m, 'new Order'), m, 4),
        { k: 'loop', c: 'for each product in products', ...at(m, 5), s: [call(named(m, 'Price'), m, 7), call(named(m, 'AddLine'), m, 8)] },
        call(named(m, 'Place'), m, 10),
        call(named(m, 'Add'), m, 11),
        call(named(m, 'Commit'), m, 12, { aw: true }),
        call(named(m, 'SendConfirmation'), m, 13, { aw: true }),
        { k: 'return', c: 'order', ...at(m, 14) },
      ].map((s) => s);
    }
    if (m.label === 'Order.Cancel') {
      return [
        { k: 'if', c: 'Status == OrderStatus.Shipped', ...at(m, 1), b: [{ c: 'yes', s: [{ k: 'throw', c: 'new InvalidOperationException("Already shipped")', ...at(m, 2) }] }, { c: 'no', s: [] }] },
        call(named(m, 'new OrderCancelled'), m, 3),
        call(named(m, 'Raise'), m, 4),
      ];
    }
    return [...m.out.keys()].map((c, i) => call(c, m, i));
  };

  return { k: 'call', m: entry.id, f: entry.file, l: entry.l, s: body(entry) };
};
