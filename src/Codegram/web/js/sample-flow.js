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

  // arguments named like the parameters, results stored in a variable named after their type
  const lower = (t) => t.replace(/<.*/, '').replace(/^Task<?|>$/g, '').replace(/^./, (ch) => ch.toLowerCase());
  const call = (callee, caller, i, extra = {}) => {
    const r = callee.k === 'ctor' ? callee.type.n : callee.r && CG.unwrapTask(callee.r);
    const s = { k: 'call', m: callee.id, ...at(caller, i), a: callee.pn ? callee.pn.slice() : undefined, v: r ? lower(r) : undefined, ...extra };
    if (r && callee.k !== 'ctor') s.rv = [lower(r)];
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
          { c: 'try', s: [call(named(m, 'Place'), m, 2, { aw: true, on: '_service', a: ['_customer', 'CartItems()'], v: 'order' })] },
          { c: 'catch InvalidOperationException', ct: 'InvalidOperationException', s: [call(named(m, 'ShowError'), m, 6, { a: ['$"Could not place the order: {ex.Message}"'] })] },
        ],
      }];
    }
    if (m.label === 'OrderService.Place') {
      return [
        call(named(m, 'NotNull'), m, 1),
        { k: 'if', c: 'products.Count == 0', ...at(m, 2), b: [{ c: 'yes', s: [{ k: 'throw', c: 'new ArgumentException("An order needs products")', tt: ['ArgumentException', 'SystemException', 'Exception'], ...at(m, 3) }] }, { c: 'no', s: [] }] },
        call(named(m, 'new Order'), m, 4, { v: 'order' }),
        { k: 'loop', c: 'for each product in products', ...at(m, 5), s: [
          call(named(m, 'Price'), m, 7, { on: 'pricing', v: 'price' }),
          call(named(m, 'AddLine'), m, 8, { on: 'order', a: ['product', '1'] }),
        ] },
        call(named(m, 'Place'), m, 10, { on: 'order' }),
        call(named(m, 'Add'), m, 11, { on: 'orders', a: ['order'] }),
        call(named(m, 'Commit'), m, 12, { aw: true, on: 'work' }),
        call(named(m, 'SendConfirmation'), m, 13, { aw: true, on: 'mail', a: ['order'] }),
        { k: 'return', c: 'order', ...at(m, 14) },
      ].map((s) => s);
    }
    if (m.label === 'Order.Cancel') {
      return [
        { k: 'if', c: 'Status == OrderStatus.Shipped', ...at(m, 1), b: [{ c: 'yes', s: [{ k: 'throw', c: 'new InvalidOperationException("Already shipped")', tt: ['InvalidOperationException', 'SystemException', 'Exception'], ...at(m, 2) }] }, { c: 'no', s: [] }] },
        call(named(m, 'new OrderCancelled'), m, 3),
        call(named(m, 'Raise'), m, 4),
      ];
    }
    return [...m.out.keys()].map((c, i) => call(c, m, i));
  };

  return { k: 'call', m: entry.id, f: entry.file, l: entry.l, s: body(entry) };
};
