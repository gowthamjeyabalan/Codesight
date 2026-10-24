using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Newtonsoft.Json;

namespace Codegram
{
    /// <summary>One step of a flow: a call, a decision, a loop, an early return or a throw.</summary>
    sealed class FlowStep
    {
        /// <summary>call, if, switch, loop, try, return or throw.</summary>
        [JsonProperty("k")] public string Kind;
        /// <summary>Condition, loop header or returned expression; for calls outside the solution, their name.</summary>
        [JsonProperty("c", NullValueHandling = NullValueHandling.Ignore)] public string Text;
        /// <summary>The member called, by its id in the code model.</summary>
        [JsonProperty("m", NullValueHandling = NullValueHandling.Ignore)] public int? Member;
        [JsonProperty("f")] public string File;
        /// <summary>Zero-based line of the step in its file.</summary>
        [JsonProperty("l")] public int Line;
        [JsonProperty("aw", DefaultValueHandling = DefaultValueHandling.Ignore)] public bool Await;
        /// <summary>What a call runs, or the body of a loop.</summary>
        [JsonProperty("s", NullValueHandling = NullValueHandling.Ignore)] public List<FlowStep> Steps;
        /// <summary>The ways a decision can go; for a call through an interface or a virtual method, each implementation.</summary>
        [JsonProperty("b", NullValueHandling = NullValueHandling.Ignore)] public List<FlowBranch> Branches;
        /// <summary>Why a call was not followed: seen (shown earlier), recursion, depth or budget.</summary>
        [JsonProperty("x", NullValueHandling = NullValueHandling.Ignore)] public string Stop;
    }

    sealed class FlowBranch
    {
        [JsonProperty("c")] public string Label;
        /// <summary>The implementation this branch runs, for calls through an interface or a virtual method.</summary>
        [JsonProperty("m", NullValueHandling = NullValueHandling.Ignore)] public int? Member;
        [JsonProperty("s")] public List<FlowStep> Steps = new List<FlowStep>();
    }

    /// <summary>
    /// Follows what runs when a method is called: its statements in order, the calls into the solution's own code
    /// (followed into their bodies, and into every implementation for interface and virtual calls), the decisions,
    /// loops and try blocks around them, and early returns and throws. Calls outside the solution are left out
    /// unless they run a lambda from it (as LINQ does). Lambdas count where they are passed, not where they are made.
    /// </summary>
    static class FlowAnalyzer
    {
        const int MaxDepth = 10;
        /// <summary>Calls followed in one flow at most, so a call into the middle of a big code base stays readable.</summary>
        public const int Budget = 2500;
        const int MaxImplementations = 6;

        sealed class Context
        {
            public Solution Solution;
            public CancellationToken Ct;
            public string Root;
            public Dictionary<string, int> Ids;
            public int Count;
#pragma warning disable RS1024 // these do compare with SymbolEqualityComparer; the analyzer misreads the constructor
            public readonly HashSet<ISymbol> Expanded = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            public readonly HashSet<ISymbol> Active = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
#pragma warning restore RS1024
            public readonly Dictionary<SyntaxTree, SemanticModel> Models = new Dictionary<SyntaxTree, SemanticModel>();
        }

        /// <summary>The flow of the member with documentation id <paramref name="docId"/>, or null when it is not in the solution.</summary>
        public static async Task<FlowStep> AnalyzeAsync(Solution solution, string docId, Dictionary<string, int> ids, string root, CancellationToken ct)
        {
            var c = new Context { Solution = solution, Ct = ct, Root = root, Ids = ids };
            IMethodSymbol method = null;
            foreach (var project in solution.Projects)
            {
                if (project.Language != LanguageNames.CSharp)
                    continue;
                var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
                if (compilation == null)
                    continue;
                if (DocumentationCommentId.GetFirstSymbolForDeclarationId(docId, compilation) is IMethodSymbol m && m.Locations.Any(l => l.IsInSource))
                {
                    method = m;
                    break;
                }
            }
            if (method == null)
                return null;

            var loc = method.Locations.First(l => l.IsInSource);
            var start = new FlowStep
            {
                Kind = "call",
                Member = ids.TryGetValue(docId, out var id) ? id : (int?)null,
                File = CodeAnalyzer.Relative(root, loc.SourceTree.FilePath),
                Line = loc.GetLineSpan().StartLinePosition.Line,
            };
            c.Expanded.Add(method);
            c.Active.Add(method);
            start.Steps = await BodyAsync(c, method).ConfigureAwait(false);
            return start;
        }

        async static Task<SemanticModel> ModelAsync(Context c, SyntaxTree tree)
        {
            if (c.Models.TryGetValue(tree, out var model))
                return model;
            var doc = c.Solution.GetDocument(tree);
            model = doc == null ? null : await doc.GetSemanticModelAsync(c.Ct).ConfigureAwait(false);
            c.Models[tree] = model;
            return model;
        }

        /// <summary>The steps of a method's body (block or expression), or null when it has no source body.</summary>
        static async Task<List<FlowStep>> BodyAsync(Context c, IMethodSymbol method)
        {
            foreach (var reference in method.DeclaringSyntaxReferences)
            {
                if (CodeAnalyzer.IsGenerated(reference.SyntaxTree.FilePath))
                    continue;
                var node = await reference.GetSyntaxAsync(c.Ct).ConfigureAwait(false);
                var model = await ModelAsync(c, node.SyntaxTree).ConfigureAwait(false);
                if (model == null)
                    continue;
                var steps = new List<FlowStep>();
                var w = new Walker(c, model);
                switch (node)
                {
                    case ConstructorDeclarationSyntax ctor:
                        if (ctor.Initializer != null)
                            await w.ExprAsync(ctor.Initializer, steps).ConfigureAwait(false);
                        await w.BodyAsync(ctor.Body, ctor.ExpressionBody?.Expression, steps).ConfigureAwait(false);
                        break;
                    case BaseMethodDeclarationSyntax m:
                        await w.BodyAsync(m.Body, m.ExpressionBody?.Expression, steps).ConfigureAwait(false);
                        break;
                    case LocalFunctionStatementSyntax f:
                        await w.BodyAsync(f.Body, f.ExpressionBody?.Expression, steps).ConfigureAwait(false);
                        break;
                    default:
                        continue;
                }
                return steps;
            }
            return null;
        }

        /// <summary>Walks one method body in the order it runs.</summary>
        sealed class Walker
        {
            readonly Context c;
            readonly SemanticModel model;

            public Walker(Context c, SemanticModel model)
            {
                this.c = c;
                this.model = model;
            }

            FlowStep At(SyntaxNode node, string kind, string text = null) => new FlowStep
            {
                Kind = kind,
                Text = text,
                File = CodeAnalyzer.Relative(c.Root, node.SyntaxTree.FilePath),
                Line = node.GetLocation().GetLineSpan().StartLinePosition.Line,
            };

            public async Task BodyAsync(BlockSyntax block, ExpressionSyntax expression, List<FlowStep> into)
            {
                if (block != null)
                    await StatementsAsync(block.Statements, into, false).ConfigureAwait(false);
                else if (expression != null)
                    await ExprAsync(expression, into).ConfigureAwait(false);
            }

            async Task StatementsAsync(IEnumerable<StatementSyntax> statements, List<FlowStep> into, bool inBranch)
            {
                foreach (var s in statements)
                    await StatementAsync(s, into, inBranch).ConfigureAwait(false);
            }

            async Task<List<FlowStep>> BranchAsync(StatementSyntax s)
            {
                var steps = new List<FlowStep>();
                if (s != null)
                    await StatementAsync(s, steps, true).ConfigureAwait(false);
                return steps;
            }

            async Task StatementAsync(StatementSyntax s, List<FlowStep> into, bool inBranch)
            {
                c.Ct.ThrowIfCancellationRequested();
                switch (s)
                {
                    case BlockSyntax b:
                        await StatementsAsync(b.Statements, into, inBranch).ConfigureAwait(false);
                        break;

                    case IfStatementSyntax i:
                    {
                        await ExprAsync(i.Condition, into).ConfigureAwait(false);
                        var step = At(i, "if", Short(i.Condition));
                        step.Branches = new List<FlowBranch> { new FlowBranch { Label = "yes", Steps = await BranchAsync(i.Statement).ConfigureAwait(false) } };
                        step.Branches.Add(new FlowBranch { Label = i.Else != null ? "else" : "no", Steps = await BranchAsync(i.Else?.Statement).ConfigureAwait(false) });
                        AddDecision(into, step);
                        break;
                    }

                    case SwitchStatementSyntax sw:
                    {
                        await ExprAsync(sw.Expression, into).ConfigureAwait(false);
                        var step = At(sw, "switch", Short(sw.Expression));
                        step.Branches = new List<FlowBranch>();
                        foreach (var section in sw.Sections)
                        {
                            var branch = new FlowBranch { Label = string.Join(", ", section.Labels.Select(l => Short(l.ToString().TrimEnd(':').Replace("case ", "")))) };
                            await StatementsAsync(section.Statements, branch.Steps, true).ConfigureAwait(false);
                            step.Branches.Add(branch);
                        }
                        AddDecision(into, step);
                        break;
                    }

                    case ForEachStatementSyntax fe:
                        await ExprAsync(fe.Expression, into).ConfigureAwait(false);
                        AddLoop(into, At(fe, "loop", $"for each {fe.Identifier.Text} in {Short(fe.Expression)}"), await BranchAsync(fe.Statement).ConfigureAwait(false));
                        break;

                    case ForEachVariableStatementSyntax fv:
                        await ExprAsync(fv.Expression, into).ConfigureAwait(false);
                        AddLoop(into, At(fv, "loop", $"for each {Short(fv.Variable)} in {Short(fv.Expression)}"), await BranchAsync(fv.Statement).ConfigureAwait(false));
                        break;

                    case ForStatementSyntax f:
                    {
                        if (f.Declaration != null)
                            foreach (var v in f.Declaration.Variables)
                                await ExprAsync(v.Initializer?.Value, into).ConfigureAwait(false);
                        foreach (var e in f.Initializers)
                            await ExprAsync(e, into).ConfigureAwait(false);
                        var body = new List<FlowStep>();
                        await ExprAsync(f.Condition, body).ConfigureAwait(false);
                        body.AddRange(await BranchAsync(f.Statement).ConfigureAwait(false));
                        foreach (var e in f.Incrementors)
                            await ExprAsync(e, body).ConfigureAwait(false);
                        AddLoop(into, At(f, "loop", f.Condition != null ? "for " + Short(f.Condition) : "for ever"), body);
                        break;
                    }

                    case WhileStatementSyntax wh:
                    {
                        var body = new List<FlowStep>();
                        await ExprAsync(wh.Condition, body).ConfigureAwait(false);
                        body.AddRange(await BranchAsync(wh.Statement).ConfigureAwait(false));
                        AddLoop(into, At(wh, "loop", "while " + Short(wh.Condition)), body);
                        break;
                    }

                    case DoStatementSyntax d:
                    {
                        var body = await BranchAsync(d.Statement).ConfigureAwait(false);
                        await ExprAsync(d.Condition, body).ConfigureAwait(false);
                        AddLoop(into, At(d, "loop", "repeat while " + Short(d.Condition)), body);
                        break;
                    }

                    case TryStatementSyntax t:
                    {
                        var step = At(t, "try", "try");
                        step.Branches = new List<FlowBranch> { new FlowBranch { Label = "try", Steps = await BranchAsync(t.Block).ConfigureAwait(false) } };
                        foreach (var katch in t.Catches)
                        {
                            var label = katch.Declaration != null ? "catch " + katch.Declaration.Type : "catch";
                            step.Branches.Add(new FlowBranch { Label = Short(label), Steps = await BranchAsync(katch.Block).ConfigureAwait(false) });
                        }
                        if (t.Finally != null)
                            step.Branches.Add(new FlowBranch { Label = "finally", Steps = await BranchAsync(t.Finally.Block).ConfigureAwait(false) });
                        // a try whose catches do nothing worth showing is just its block
                        if (step.Branches.Skip(1).All(b => b.Steps.Count == 0))
                            into.AddRange(step.Branches[0].Steps);
                        else
                            AddDecision(into, step);
                        break;
                    }

                    case UsingStatementSyntax u:
                        if (u.Declaration != null)
                            foreach (var v in u.Declaration.Variables)
                                await ExprAsync(v.Initializer?.Value, into).ConfigureAwait(false);
                        await ExprAsync(u.Expression, into).ConfigureAwait(false);
                        await StatementAsync(u.Statement, into, inBranch).ConfigureAwait(false);
                        break;
                    case LockStatementSyntax l:
                        await ExprAsync(l.Expression, into).ConfigureAwait(false);
                        await StatementAsync(l.Statement, into, inBranch).ConfigureAwait(false);
                        break;
                    case CheckedStatementSyntax ch:
                        await StatementAsync(ch.Block, into, inBranch).ConfigureAwait(false);
                        break;
                    case UnsafeStatementSyntax us:
                        await StatementAsync(us.Block, into, inBranch).ConfigureAwait(false);
                        break;
                    case FixedStatementSyntax fx:
                        await StatementAsync(fx.Statement, into, inBranch).ConfigureAwait(false);
                        break;
                    case LabeledStatementSyntax lb:
                        await StatementAsync(lb.Statement, into, inBranch).ConfigureAwait(false);
                        break;

                    case ReturnStatementSyntax r:
                        await ExprAsync(r.Expression, into).ConfigureAwait(false);
                        // the return at the end of a method is where it ends anyway; early ones change the flow
                        if (inBranch)
                            into.Add(At(r, "return", r.Expression != null ? Short(r.Expression) : ""));
                        break;
                    case ThrowStatementSyntax th:
                        await ExprAsync(th.Expression, into).ConfigureAwait(false);
                        into.Add(At(th, "throw", th.Expression != null ? Short(th.Expression) : ""));
                        break;

                    case LocalDeclarationStatementSyntax ld:
                        foreach (var v in ld.Declaration.Variables)
                            await ExprAsync(v.Initializer?.Value, into).ConfigureAwait(false);
                        break;
                    case ExpressionStatementSyntax es:
                        await ExprAsync(es.Expression, into).ConfigureAwait(false);
                        break;
                    case LocalFunctionStatementSyntax _:
                        // a declaration: it runs where it is called
                        break;
                    default:
                        await ChildrenAsync(s, into).ConfigureAwait(false);
                        break;
                }
            }

            /// <summary>Decisions where nothing happens on any side are left out.</summary>
            static void AddDecision(List<FlowStep> into, FlowStep step)
            {
                if (step.Branches.Any(b => b.Steps.Count > 0))
                    into.Add(step);
            }

            static void AddLoop(List<FlowStep> into, FlowStep step, List<FlowStep> body)
            {
                if (body.Count == 0)
                    return;
                step.Steps = body;
                into.Add(step);
            }

            /// <summary>Calls in an expression in the order they run: receivers and arguments before the call.</summary>
            public async Task ExprAsync(SyntaxNode e, List<FlowStep> into)
            {
                switch (e)
                {
                    case null:
                    case AnonymousFunctionExpressionSyntax _:
                        // a lambda runs when it is called, not where it is written
                        return;

                    case InvocationExpressionSyntax inv:
                    {
                        if (inv.Expression is MemberAccessExpressionSyntax ma)
                            await ExprAsync(ma.Expression, into).ConfigureAwait(false);
                        var callbacks = await ArgumentsAsync(inv.ArgumentList, into).ConfigureAwait(false);
                        await CallAsync(inv, into, callbacks).ConfigureAwait(false);
                        return;
                    }

                    case BaseObjectCreationExpressionSyntax oc:
                    {
                        var callbacks = await ArgumentsAsync(oc.ArgumentList, into).ConfigureAwait(false);
                        await CallAsync(oc, into, callbacks).ConfigureAwait(false);
                        if (oc.Initializer != null)
                            await ChildrenAsync(oc.Initializer, into).ConfigureAwait(false);
                        return;
                    }

                    case ConstructorInitializerSyntax ci:
                    {
                        var callbacks = await ArgumentsAsync(ci.ArgumentList, into).ConfigureAwait(false);
                        await CallAsync(ci, into, callbacks).ConfigureAwait(false);
                        return;
                    }

                    case AwaitExpressionSyntax aw:
                    {
                        int before = into.Count;
                        await ExprAsync(aw.Expression, into).ConfigureAwait(false);
                        if (into.Count > before)
                            into[into.Count - 1].Await = true;
                        return;
                    }

                    case AssignmentExpressionSyntax a:
                        // subscribing a handler runs nothing yet
                        if (a.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AddAssignmentExpression) || a.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SubtractAssignmentExpression))
                        {
                            var symbol = model.GetSymbolInfo(a.Left, c.Ct).Symbol;
                            if (symbol is IEventSymbol)
                                return;
                        }
                        await ExprAsync(a.Right, into).ConfigureAwait(false);
                        return;

                    default:
                        await ChildrenAsync(e, into).ConfigureAwait(false);
                        return;
                }
            }

            async Task ChildrenAsync(SyntaxNode node, List<FlowStep> into)
            {
                foreach (var child in node.ChildNodes())
                {
                    if (child is StatementSyntax)
                        continue;
                    await ExprAsync(child, into).ConfigureAwait(false);
                }
            }

            /// <summary>Walks the arguments; lambdas passed along are walked as callbacks of the call.</summary>
            async Task<List<FlowStep>> ArgumentsAsync(ArgumentListSyntax args, List<FlowStep> into)
            {
                var callbacks = new List<FlowStep>();
                if (args == null)
                    return callbacks;
                foreach (var arg in args.Arguments)
                {
                    if (arg.Expression is AnonymousFunctionExpressionSyntax fn)
                    {
                        if (fn.Block != null)
                            await StatementsAsync(fn.Block.Statements, callbacks, false).ConfigureAwait(false);
                        else
                            await ExprAsync(fn.ExpressionBody, callbacks).ConfigureAwait(false);
                    }
                    else
                        await ExprAsync(arg.Expression, into).ConfigureAwait(false);
                }
                return callbacks;
            }

            async Task CallAsync(SyntaxNode node, List<FlowStep> into, List<FlowStep> callbacks)
            {
                var info = model.GetSymbolInfo(node, c.Ct);
                if (!((info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) is IMethodSymbol target))
                {
                    into.AddRange(callbacks);
                    return;
                }
                target = (target.ReducedFrom ?? target).OriginalDefinition;
                var docId = target.GetDocumentationCommentId();
                int? id = docId != null && c.Ids.TryGetValue(docId, out var found) ? found : (int?)null;

                if (id == null)
                {
                    // outside the solution: only worth a step when it runs our code back (Select(x => Fix(x)))
                    if (callbacks.Count == 0)
                        return;
                    var outside = At(node, "call", (target.ContainingType?.Name ?? "") + "." + target.Name);
                    outside.Steps = callbacks;
                    into.Add(outside);
                    return;
                }

                var step = At(node, "call");
                step.Member = id;
                into.Add(step);
                if (++c.Count > Budget)
                {
                    step.Stop = "budget";
                    return;
                }

                bool baseCall = node is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax ma && ma.Expression is BaseExpressionSyntax;
                bool dispatched = !baseCall && (target.ContainingType.TypeKind == TypeKind.Interface || target.IsAbstract || target.IsVirtual || target.IsOverride);
                if (dispatched)
                {
                    var impls = await ImplementationsAsync(target).ConfigureAwait(false);
                    if (impls.Count > 0)
                    {
                        step.Branches = new List<FlowBranch>();
                        foreach (var impl in impls)
                        {
                            var implId = c.Ids.TryGetValue(impl.GetDocumentationCommentId() ?? "", out var iid) ? iid : (int?)null;
                            var branch = new FlowBranch { Label = impl.ContainingType.Name, Member = implId };
                            var (steps, stop) = await FollowAsync(impl).ConfigureAwait(false);
                            if (steps != null)
                                branch.Steps = steps;
                            step.Branches.Add(branch);
                            if (stop != null && impls.Count == 1)
                                step.Stop = stop;
                        }
                        if (callbacks.Count > 0)
                            step.Steps = callbacks;
                        return;
                    }
                }

                var (body, why) = await FollowAsync(target).ConfigureAwait(false);
                step.Stop = why;
                if (callbacks.Count > 0)
                    body = (body ?? new List<FlowStep>()).Concat(callbacks).ToList();
                step.Steps = body != null && body.Count > 0 ? body : null;
            }

            /// <summary>The body of a called method, unless it is already on the way here, was shown before, or is too deep.</summary>
            async Task<(List<FlowStep> steps, string stop)> FollowAsync(IMethodSymbol method)
            {
                if (c.Active.Contains(method))
                    return (null, "recursion");
                if (c.Expanded.Contains(method))
                    return (null, "seen");
                if (c.Active.Count >= MaxDepth)
                    return (null, "depth");
                c.Expanded.Add(method);
                c.Active.Add(method);
                try { return (await FlowAnalyzer.BodyAsync(c, method).ConfigureAwait(false), null); }
                finally { c.Active.Remove(method); }
            }

            /// <summary>Source implementations an interface or virtual call can land in (the method itself too, when it has a body).</summary>
            async Task<List<IMethodSymbol>> ImplementationsAsync(IMethodSymbol target)
            {
                var list = new List<IMethodSymbol>();
                if (!target.IsAbstract && target.ContainingType.TypeKind != TypeKind.Interface && target.Locations.Any(l => l.IsInSource))
                    list.Add(target);
                IEnumerable<ISymbol> found;
                try
                {
                    found = target.ContainingType.TypeKind == TypeKind.Interface
                        ? await SymbolFinder.FindImplementationsAsync(target, c.Solution, cancellationToken: c.Ct).ConfigureAwait(false)
                        : await SymbolFinder.FindOverridesAsync(target, c.Solution, cancellationToken: c.Ct).ConfigureAwait(false);
                }
                catch (Exception ex) when (!(ex is OperationCanceledException))
                {
                    found = Enumerable.Empty<ISymbol>();
                }
                foreach (var s in found)
                    if (s is IMethodSymbol m && m.Locations.Any(l => l.IsInSource) && !list.Contains(m, SymbolEqualityComparer.Default))
                        list.Add(m);
                return list.Take(MaxImplementations).ToList();
            }

            static readonly Regex Spaces = new Regex(@"\s+");

            static string Short(SyntaxNode node) => node == null ? "" : Short(node.ToString());

            static string Short(string text)
            {
                text = Spaces.Replace(text, " ").Trim();
                return text.Length > 70 ? text.Substring(0, 69) + "…" : text;
            }
        }
    }
}
