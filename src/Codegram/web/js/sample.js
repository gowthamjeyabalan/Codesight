'use strict';
// A made-up mixed-language repository, used when the page runs in a plain browser (no Visual Studio host).
CG.sample = function () {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const f = (n, g, lo, hi) => {
    const c = Math.round(lo + rnd() * (hi - lo));
    return { n, g, c, b: Math.round(c * (28 + rnd() * 14)) };
  };
  const many = (names, ext, g, lo, hi) => names.split(' ').map((n) => f(n + ext, g, lo, hi));
  const d = (n, ...k) => ({ n, k: k.flat() });

  return d('Contoso',
    d('src',
      d('Contoso.Api',
        d('Controllers', many('Orders Customers Products Invoices Auth Health', 'Controller.cs', 'cs', 60, 420)),
        d('Services', many('OrderService PricingService MailService TokenService CacheService SearchService InventoryService', '.cs', 'cs', 80, 650)),
        d('Models', many('Order OrderLine Customer Product Invoice Address Money Sku Page Result', '.cs', 'cs', 15, 140)),
        f('Program.cs', 'cs', 40, 90), f('appsettings.json', 'data', 20, 60), f('Contoso.Api.csproj', 'data', 20, 40)),
      d('Contoso.Core',
        d('Domain', many('Aggregate Entity ValueObject DomainEvent Specification Guard', '.cs', 'cs', 30, 260)),
        d('Infrastructure', many('DbContext Repository UnitOfWork Migrations Outbox', '.cs', 'cs', 90, 900)),
        f('Contoso.Core.csproj', 'data', 15, 30)),
      d('Contoso.Tests', many('OrderTests PricingTests AuthTests ApiFixture', '.cs', 'cs', 70, 520))),
    d('web',
      d('src',
        d('components', many('Button Table Chart Sidebar Header Modal OrderForm CustomerCard Pager Toast Tabs Search', '.tsx', 'ts', 30, 320)),
        d('hooks', many('useOrders useAuth useDebounce useQuery', '.ts', 'ts', 15, 120)),
        d('pages', many('Home Orders Customers Settings Login', '.tsx', 'ts', 60, 380)),
        d('styles', many('app theme tokens', '.css', 'web', 40, 400)),
        f('main.tsx', 'ts', 15, 40), f('api.ts', 'ts', 120, 300)),
      f('package.json', 'data', 30, 60), f('tsconfig.json', 'data', 15, 30), f('vite.config.ts', 'ts', 15, 40), f('index.html', 'web', 12, 25)),
    d('engine',
      d('src', many('lib graph layout pricing tax cache', '.rs', 'rs', 120, 1400)),
      d('benches', many('layout pricing', '.rs', 'rs', 40, 160)),
      f('Cargo.toml', 'data', 15, 40)),
    d('tools', many('seed_db export_report lint_sql migrate', '.py', 'py', 40, 300), f('requirements.txt', 'doc', 5, 20), f('build.ps1', 'script', 30, 120)),
    d('docs', many('architecture api deployment pricing-rules', '.md', 'doc', 40, 400), d('images', many('overview flow', '.png', 'other', 0, 0))),
    f('README.md', 'doc', 40, 140), f('Contoso.sln', 'data', 40, 80), f('.gitignore', 'other', 0, 0), f('LICENSE', 'other', 0, 0));
};
