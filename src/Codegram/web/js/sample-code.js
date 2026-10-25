'use strict';
// A made-up C# model in the shape CodeAnalyzer.cs sends, matching the made-up repository in sample.js.
CG.sampleCode = function () {
  let id = 0;
  const types = [], byName = new Map(), members = new Map();
  const access = { '+': 'public', '-': 'private', '#': 'protected', '~': 'internal' };
  const COMPLEX = { 'OrderService.Place': 14, 'PricingService.Price': 11, 'Order.Recalculate': 8, 'SmtpMailService.Render': 23, 'CsvExporter.Export': 9, 'OrdersController.Post': 7 };
  // T(namespace, name, kind, file, line, members, extra): members are "<access> <kind> <name><signature>"
  const T = (ns, n, k, f, l, ms, extra = {}) => {
    const short = n.replace(/<.*/, '');
    const t = { id: id++, n, ns, k, a: 'public', p: ns.split('.').slice(0, 2).join('.'), f, l, m: [], ...extra };
    let line = l + 2;
    for (const spec of ms) {
      const [, mark, kind, name, sig] = spec.match(/^([+\-#~]) (\w+) (\w+)(.*)$/);
      const x = { id: id++, n: kind === 'ctor' ? short : name, k: kind, s: sig.trim(), a: access[mark], l: line };
      if (x.s.includes('static ')) { x.st = true; x.s = x.s.replace('static ', ''); }
      // what it gives back and its parameter names, as CodeAnalyzer.cs sends them
      const ret = /\)?: (.+)$/.exec(x.s);
      if (ret && kind !== 'ctor' && ret[1] !== 'void') x.r = ret[1];
      const params = /^\((.*)\)/.exec(x.s);
      if (params && params[1]) x.pn = params[1].split(', ').map((p) => p.split(' ').pop());
      // made-up size and complexity: methods take nine lines, a few named below are complex
      const body = kind === 'method' || kind === 'ctor';
      x.le = line + (body ? 7 : 0);
      if (body || kind === 'prop') x.cx = COMPLEX[`${short}.${name}`] || (body ? 1 + (name.length % 4) : 1);
      if (x.cx > 6) x.nd = Math.min(5, Math.floor(x.cx / 4));
      line += body ? 9 : 1;
      t.m.push(x);
      members.set(`${short}.${name}`, x);
    }
    t.le = line + 1;
    types.push(t);
    byName.set(short, t);
  };
  const D = 'Contoso.Core.Domain', M = 'Contoso.Api.Models', I = 'Contoso.Core.Infrastructure', S = 'Contoso.Api.Services', C = 'Contoso.Api.Controllers';
  T(D, 'Entity', 'class', 'src/Contoso.Core/Domain/Entity.cs', 4, ['+ prop Id: Guid', '+ method Equals(object other): bool', '+ method GetHashCode(): int', '# ctor ctor()'], { mod: 'abstract' });
  T(D, 'IAggregateRoot', 'interface', 'src/Contoso.Core/Domain/Aggregate.cs', 3, ['+ prop Events: IReadOnlyList<DomainEvent>', '+ method ClearEvents()']);
  T(D, 'DomainEvent', 'record', 'src/Contoso.Core/Domain/DomainEvent.cs', 3, ['+ prop OccurredAt: DateTime'], { mod: 'abstract' });
  T(D, 'OrderPlaced', 'record', 'src/Contoso.Core/Domain/DomainEvent.cs', 9, ['+ prop OrderId: Guid', '+ prop Total: Money', '+ ctor ctor(Guid orderId, Money total)']);
  T(D, 'OrderCancelled', 'record', 'src/Contoso.Core/Domain/DomainEvent.cs', 14, ['+ prop OrderId: Guid', '+ ctor ctor(Guid orderId)']);
  T(D, 'Guard', 'class', 'src/Contoso.Core/Domain/Guard.cs', 3, ['+ method NotNull(object value, string name): static void', '+ method Positive(int value, string name): static void'], { mod: 'static' });
  T(M, 'Order', 'class', 'src/Contoso.Api/Models/Order.cs', 6, ['- field lines: List<OrderLine>', '- field events: List<DomainEvent>', '+ prop Customer: Customer', '+ prop Status: OrderStatus', '+ prop Total: Money', '+ prop Events: IReadOnlyList<DomainEvent>', '+ ctor ctor(Customer customer)', '+ method AddLine(Product product, int quantity)', '+ method RemoveLine(Guid lineId)', '+ method Place()', '+ method Cancel(string reason)', '+ method ClearEvents()', '- method Recalculate()', '- method Raise(DomainEvent e)']);
  T(M, 'OrderLine', 'class', 'src/Contoso.Api/Models/OrderLine.cs', 4, ['+ prop Product: Product', '+ prop Quantity: int', '+ prop UnitPrice: Money', '+ ctor ctor(Product product, int quantity, Money unitPrice)', '+ method Total(): Money']);
  T(M, 'OrderStatus', 'enum', 'src/Contoso.Api/Models/Order.cs', 120, ['+ value Draft', '+ value Placed', '+ value Shipped', '+ value Cancelled']);
  T(M, 'Customer', 'class', 'src/Contoso.Api/Models/Customer.cs', 4, ['+ prop Name: string', '+ prop Email: string', '+ prop Address: Address', '+ prop Events: IReadOnlyList<DomainEvent>', '+ method Rename(string name)', '+ method ClearEvents()']);
  T(M, 'Product', 'class', 'src/Contoso.Api/Models/Product.cs', 4, ['+ prop Sku: string', '+ prop Name: string', '+ prop Price: Money', '+ method Reprice(Money price)']);
  T(M, 'Address', 'record', 'src/Contoso.Api/Models/Address.cs', 3, ['+ prop Street: string', '+ prop City: string', '+ prop Country: string']);
  T(M, 'Money', 'record struct', 'src/Contoso.Api/Models/Money.cs', 3, ['+ prop Amount: decimal', '+ prop Currency: string', '+ method Add(Money other): Money', '+ method Multiply(decimal factor): Money', '+ prop Zero: static Money']);
  T(I, 'IRepository<T>', 'interface', 'src/Contoso.Core/Infrastructure/Repository.cs', 5, ['+ method Get(Guid id): Task<T>', '+ method Add(T item)', '+ method Remove(T item)']);
  T(I, 'Repository<T>', 'class', 'src/Contoso.Core/Infrastructure/Repository.cs', 14, ['# field db: ContosoDbContext', '+ ctor ctor(ContosoDbContext db)', '+ method Get(Guid id): Task<T>', '+ method Add(T item)', '+ method Remove(T item)']);
  T(I, 'OrderRepository', 'class', 'src/Contoso.Core/Infrastructure/Repository.cs', 52, ['+ ctor ctor(ContosoDbContext db)', '+ method ForCustomer(Guid customerId): Task<List<Order>>']);
  T(I, 'ContosoDbContext', 'class', 'src/Contoso.Core/Infrastructure/DbContext.cs', 6, ['+ prop Orders: DbSet<Order>', '+ prop Customers: DbSet<Customer>', '+ prop Products: DbSet<Product>', '+ method Set(): DbSet<T>', '+ method SaveChanges(): Task<int>', '# method OnModelCreating(ModelBuilder builder)']);
  T(I, 'UnitOfWork', 'class', 'src/Contoso.Core/Infrastructure/UnitOfWork.cs', 4, ['- field db: ContosoDbContext', '- field outbox: Outbox', '+ ctor ctor(ContosoDbContext db, Outbox outbox)', '+ method Commit(): Task']);
  T(I, 'Outbox', 'class', 'src/Contoso.Core/Infrastructure/Outbox.cs', 4, ['+ method Enqueue(DomainEvent e)', '+ method Flush(): Task']);
  T(S, 'IPricingService', 'interface', 'src/Contoso.Api/Services/PricingService.cs', 3, ['+ method Price(Product product, Customer customer): Money']);
  T(S, 'PricingService', 'class', 'src/Contoso.Api/Services/PricingService.cs', 9, ['- field taxes: TaxTable', '+ ctor ctor(TaxTable taxes)', '+ method Price(Product product, Customer customer): Money', '- method Discount(Customer customer): decimal']);
  T(S, 'TaxTable', 'class', 'src/Contoso.Api/Services/PricingService.cs', 60, ['+ method RateFor(string country): decimal', '- method LegacyRate(string country): decimal'], { mod: 'sealed' });
  T(S, 'CsvExporter', 'class', 'src/Contoso.Api/Services/CsvExporter.cs', 5, ['+ method Export(List<Order> orders): string', '- method Escape(string value): string']);
  T(S, 'IMailService', 'interface', 'src/Contoso.Api/Services/MailService.cs', 3, ['+ method SendConfirmation(Order order): Task']);
  T(S, 'SmtpMailService', 'class', 'src/Contoso.Api/Services/MailService.cs', 9, ['+ method SendConfirmation(Order order): Task', '- method Render(Order order): string']);
  T(S, 'OrderService', 'class', 'src/Contoso.Api/Services/OrderService.cs', 8, ['- field orders: IRepository<Order>', '- field pricing: IPricingService', '- field mail: IMailService', '- field work: UnitOfWork', '+ ctor ctor(IRepository<Order> orders, IPricingService pricing, IMailService mail, UnitOfWork work)', '+ method Find(Guid id): Task<Order>', '+ method Place(Customer customer, List<Product> products): Task<Order>', '+ method Cancel(Guid id, string reason): Task']);
  T(C, 'OrdersController', 'class', 'src/Contoso.Api/Controllers/OrdersController.cs', 7, ['- field service: OrderService', '+ ctor ctor(OrderService service)', '+ method Get(Guid id): Task<IActionResult>', '+ method Post(PlaceOrder request): Task<IActionResult>', '+ method Delete(Guid id, string reason): Task<IActionResult>']);
  T(C, 'CustomersController', 'class', 'src/Contoso.Api/Controllers/CustomersController.cs', 7, ['- field customers: IRepository<Customer>', '+ ctor ctor(IRepository<Customer> customers)', '+ method Get(Guid id): Task<IActionResult>', '+ method Rename(Guid id, string name): Task<IActionResult>']);
  T('Contoso.Desktop', 'MainWindow', 'class', 'src/Contoso.Desktop/MainWindow.xaml.cs', 10, ['- field service: OrderService', '+ ctor ctor()', '- method PlaceOrderButton_Click(object sender, RoutedEventArgs e)', '- method CancelButton_Click(object sender, RoutedEventArgs e)', '- method ShowError(string message)']);
  Object.assign(members.get('MainWindow.PlaceOrderButton_Click'), { ep: 'event', ui: 'Button “Place order” · Click' });
  Object.assign(members.get('MainWindow.CancelButton_Click'), { ep: 'event', ui: 'Button “Cancel order” · Click' });
  for (const n of ['OrdersController.Get', 'OrdersController.Post', 'OrdersController.Delete', 'CustomersController.Get', 'CustomersController.Rename']) members.get(n).ep = 'action';

  const ref = (n) => byName.get(n).id;
  const rel = (n, o) => Object.assign(byName.get(n), o);
  rel('OrderPlaced', { b: ref('DomainEvent'), u: [ref('Money')] });
  rel('OrderCancelled', { b: ref('DomainEvent') });
  rel('Order', { b: ref('Entity'), i: [ref('IAggregateRoot')], u: [ref('OrderLine'), ref('DomainEvent'), ref('Customer'), ref('OrderStatus'), ref('Money')] });
  rel('OrderLine', { b: ref('Entity'), u: [ref('Product'), ref('Money')] });
  rel('Customer', { b: ref('Entity'), i: [ref('IAggregateRoot')], u: [ref('Address')] });
  rel('Product', { b: ref('Entity'), u: [ref('Money')] });
  rel('IAggregateRoot', { u: [ref('DomainEvent')] });
  rel('Repository', { i: [ref('IRepository')], u: [ref('ContosoDbContext')] });
  rel('OrderRepository', { b: ref('Repository') });
  rel('ContosoDbContext', { u: [ref('Order'), ref('Customer'), ref('Product')] });
  rel('UnitOfWork', { u: [ref('ContosoDbContext'), ref('Outbox')] });
  rel('PricingService', { i: [ref('IPricingService')], u: [ref('TaxTable')] });
  rel('SmtpMailService', { i: [ref('IMailService')] });
  rel('OrderService', { u: [ref('IRepository'), ref('IPricingService'), ref('IMailService'), ref('UnitOfWork')] });
  rel('OrdersController', { u: [ref('OrderService')] });
  rel('CustomersController', { u: [ref('IRepository')] });

  const calls = [];
  const call = (from, to, n = 1) => calls.push(members.get(from).id, members.get(to).id, n);
  [
    ['OrdersController.Get', 'OrderService.Find'], ['OrdersController.Post', 'OrderService.Place'], ['OrdersController.Delete', 'OrderService.Cancel'],
    ['CustomersController.Get', 'IRepository.Get'], ['CustomersController.Rename', 'IRepository.Get'], ['CustomersController.Rename', 'Customer.Rename'],
    ['CustomersController.Rename', 'Guard.NotNull'], ['OrderService.Find', 'IRepository.Get'], ['OrderService.Place', 'Order.ctor'],
    ['OrderService.Place', 'Order.AddLine', 2], ['OrderService.Place', 'IPricingService.Price', 2], ['OrderService.Place', 'Order.Place'],
    ['OrderService.Place', 'IRepository.Add'], ['OrderService.Place', 'UnitOfWork.Commit'], ['OrderService.Place', 'IMailService.SendConfirmation'],
    ['OrderService.Place', 'Guard.NotNull', 2], ['OrderService.Cancel', 'IRepository.Get'], ['OrderService.Cancel', 'Order.Cancel'],
    ['OrderService.Cancel', 'UnitOfWork.Commit'], ['Order.AddLine', 'OrderLine.ctor'], ['Order.AddLine', 'Guard.Positive'],
    ['Order.AddLine', 'Order.Recalculate'], ['Order.RemoveLine', 'Order.Recalculate'], ['Order.Recalculate', 'OrderLine.Total', 2],
    ['Order.Recalculate', 'Money.Add', 2], ['Order.Place', 'Order.Raise'], ['Order.Place', 'OrderPlaced.ctor'], ['Order.Cancel', 'Order.Raise'],
    ['Order.Cancel', 'OrderCancelled.ctor'], ['OrderLine.Total', 'Money.Multiply'], ['PricingService.Price', 'TaxTable.RateFor'],
    ['PricingService.Price', 'PricingService.Discount'], ['PricingService.Price', 'Money.Multiply', 2], ['Repository.Add', 'ContosoDbContext.Set'],
    ['Repository.Get', 'ContosoDbContext.Set'], ['Repository.Remove', 'ContosoDbContext.Set'], ['OrderRepository.ForCustomer', 'ContosoDbContext.Set'],
    ['UnitOfWork.Commit', 'ContosoDbContext.SaveChanges'], ['UnitOfWork.Commit', 'Outbox.Flush'], ['SmtpMailService.SendConfirmation', 'SmtpMailService.Render'],
    ['Product.Reprice', 'Guard.NotNull'], ['MainWindow.PlaceOrderButton_Click', 'OrderService.Place'],
    ['MainWindow.PlaceOrderButton_Click', 'MainWindow.ShowError'], ['MainWindow.CancelButton_Click', 'OrderService.Cancel'],
  ].forEach(([from, to, n]) => call(from, to, n));
  rel('MainWindow', { u: [ref('OrderService')], xaml: true, fw: true });
  call('CsvExporter.Export', 'CsvExporter.Escape', 3);

  // made-up reads of properties and fields: each type's methods use its own data, a few are left with no use
  // the constructor writes them, the first method reads them
  const refs = [], writes = [], unread = new Set(['Product.Sku', 'Customer.Email', 'OrderLine.UnitPrice']);
  for (const t of types) {
    const ctor = t.m.find((x) => x.k === 'ctor'), reader = t.m.find((x) => x.k === 'method');
    for (const x of t.m) {
      if ((x.k !== 'prop' && x.k !== 'field') || unread.has(`${t.n.replace(/<.*/, '')}.${x.n}`)) continue;
      if (ctor) { refs.push(ctor.id, x.id, 1); writes.push(ctor.id, x.id, 1); }
      if (reader) refs.push(reader.id, x.id, 2);
    }
  }
  // the order's total is also written as lines change
  const recalc = members.get('Order.Recalculate'), total = members.get('Order.Total');
  refs.push(recalc.id, total.id, 1);
  writes.push(recalc.id, total.id, 1);
  // interface implementations, as CodeAnalyzer.cs links them
  for (const t of types)
    for (const iid of t.i || []) {
      const iface = types.find((x) => x.id === iid);
      for (const im of iface.m) {
        const impl = t.m.find((x) => x.n === im.n);
        if (impl) { impl.im = [im.id]; impl.ov = true; }
      }
    }
  for (const n of ['Entity.Equals', 'Entity.GetHashCode']) members.get(n).ov = true;

  const projectRefs = [['Contoso.Api', 'Contoso.Core'], ['Contoso.Desktop', 'Contoso.Api'], ['Contoso.Desktop', 'Contoso.Core']];
  return { type: 'code', projects: ['Contoso.Api', 'Contoso.Core', 'Contoso.Desktop'], types, calls, refs, writes, projectRefs, truncated: false, maxTypes: 20000, seconds: 0.42 };
};
