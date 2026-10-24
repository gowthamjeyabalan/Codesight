using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Newtonsoft.Json;

namespace Codegram
{
    /// <summary>A type declared in the solution's C# source. Short JSON names keep the message small.</summary>
    sealed class CodeType
    {
        [JsonProperty("id")] public int Id;
        /// <summary>Name with type parameters, as in "Repository&lt;T&gt;"; nested types as "Outer.Inner".</summary>
        [JsonProperty("n")] public string Name;
        [JsonProperty("ns")] public string Namespace;
        /// <summary>class, struct, interface, enum, record, record struct or delegate.</summary>
        [JsonProperty("k")] public string Kind;
        [JsonProperty("a")] public string Access;
        [JsonProperty("mod", NullValueHandling = NullValueHandling.Ignore)] public string Modifiers;
        [JsonProperty("p")] public string Project;
        /// <summary>File relative to the mapped folder with "/" when inside it, otherwise the full path.</summary>
        [JsonProperty("f")] public string File;
        /// <summary>Zero-based line of the declaration.</summary>
        [JsonProperty("l")] public int Line;
        [JsonProperty("b", NullValueHandling = NullValueHandling.Ignore)] public int? Base;
        [JsonProperty("i", NullValueHandling = NullValueHandling.Ignore)] public List<int> Interfaces;
        /// <summary>Types of fields and properties (associations), other than the base and the interfaces.</summary>
        [JsonProperty("u", NullValueHandling = NullValueHandling.Ignore)] public List<int> Uses;
        [JsonProperty("m")] public List<CodeMember> Members = new List<CodeMember>();
    }

    sealed class CodeMember
    {
        [JsonProperty("id")] public int Id;
        [JsonProperty("n")] public string Name;
        /// <summary>method, ctor, prop, field, event, value (enum member) or operator.</summary>
        [JsonProperty("k")] public string Kind;
        /// <summary>"(int count): Order" for methods, ": string" for properties and fields.</summary>
        [JsonProperty("s")] public string Signature;
        [JsonProperty("a")] public string Access;
        [JsonProperty("st", DefaultValueHandling = DefaultValueHandling.Ignore)] public bool Static;
        [JsonProperty("abs", DefaultValueHandling = DefaultValueHandling.Ignore)] public bool Abstract;
        /// <summary>Only when the member is in another file than its type (partial types).</summary>
        [JsonProperty("f", NullValueHandling = NullValueHandling.Ignore)] public string File;
        [JsonProperty("l")] public int Line;
        /// <summary>Where a flow can start: event, command, action, test or main.</summary>
        [JsonProperty("ep", NullValueHandling = NullValueHandling.Ignore)] public string Entry;
        /// <summary>The control or event that runs an event handler, as in "Button Convert · Click".</summary>
        [JsonProperty("ui", NullValueHandling = NullValueHandling.Ignore)] public string Ui;
        /// <summary>What a method gives back (null for void and constructors); a property's or field's type.</summary>
        [JsonProperty("r", NullValueHandling = NullValueHandling.Ignore)] public string Returns;
        /// <summary>Parameter names of a method, to follow a value from an argument into the method.</summary>
        [JsonProperty("pn", NullValueHandling = NullValueHandling.Ignore)] public List<string> Parameters;
    }

    sealed class CodeModel
    {
        public List<string> Projects = new List<string>();
        public List<CodeType> Types = new List<CodeType>();
        /// <summary>Calls as flat triples: caller member id, callee member id, number of call sites.</summary>
        public List<int> Calls = new List<int>();
        public bool Truncated;
        public double Seconds;
        /// <summary>Documentation id of every member to its id, to find a member's symbol again for its flow.</summary>
        public Dictionary<string, int> MemberIds = new Dictionary<string, int>();
    }

    /// <summary>
    /// Reads the C# projects of a Roslyn solution into types, members, inheritance, associations and a call graph.
    /// Symbols are matched by documentation id, so a type seen from two projects (or two target frameworks) is one type.
    /// </summary>
    static class CodeAnalyzer
    {
        public const int MaxTypes = 20000;

        static readonly SymbolDisplayFormat TypeFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
            .WithMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

        sealed class Context
        {
            public string Root;
            public CodeModel Model = new CodeModel();
            public readonly Dictionary<string, CodeType> TypesByKey = new Dictionary<string, CodeType>();
            public readonly Dictionary<string, int> MembersByKey = new Dictionary<string, int>();
            public readonly List<(INamedTypeSymbol symbol, CodeType type)> Declared = new List<(INamedTypeSymbol, CodeType)>();
            public readonly Dictionary<long, int> Calls = new Dictionary<long, int>();
            public readonly Dictionary<int, CodeMember> Members = new Dictionary<int, CodeMember>();
            /// <summary>Event handlers by "Namespace.Type.Method", to label them with the control from XAML.</summary>
            public readonly Dictionary<string, CodeMember> Handlers = new Dictionary<string, CodeMember>();
            public int NextId;
        }

        public static async Task<CodeModel> AnalyzeAsync(Solution solution, string root, CancellationToken ct)
        {
            var watch = Stopwatch.StartNew();
            var c = new Context { Root = root };
            var compilations = new List<Compilation>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var projectDirs = new List<string>();

            foreach (var project in solution.Projects)
            {
                ct.ThrowIfCancellationRequested();
                // a multi-targeted project shows up once per framework: read it once
                if (project.Language != LanguageNames.CSharp || (project.FilePath != null && !seen.Add(project.FilePath)))
                    continue;
                var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
                if (compilation == null)
                    continue;
                c.Model.Projects.Add(StripFramework(project.Name));
                compilations.Add(compilation);
                if (project.FilePath != null)
                    projectDirs.Add(Path.GetDirectoryName(project.FilePath));
                foreach (var type in SourceTypes(compilation.Assembly.GlobalNamespace))
                    AddType(c, type, StripFramework(project.Name));
            }

            foreach (var (symbol, type) in c.Declared)
                Relate(c, symbol, type);
            foreach (var dir in projectDirs)
                ReadXaml(c, dir, ct);

            foreach (var compilation in compilations)
                foreach (var tree in compilation.SyntaxTrees)
                {
                    ct.ThrowIfCancellationRequested();
                    if (!IsGenerated(tree.FilePath))
                        await ReadCallsAsync(c, compilation, tree, ct).ConfigureAwait(false);
                }

            foreach (var pair in c.Calls)
            {
                c.Model.Calls.Add((int)(pair.Key >> 32));
                c.Model.Calls.Add((int)(pair.Key & 0xffffffff));
                c.Model.Calls.Add(pair.Value);
            }
            c.Model.Seconds = watch.Elapsed.TotalSeconds;
            foreach (var pair in c.MembersByKey)
                c.Model.MemberIds[pair.Key] = pair.Value;
            return c.Model;
        }

        /// <summary>"Codegram (net8.0)" becomes "Codegram".</summary>
        static string StripFramework(string name)
        {
            int paren = name.LastIndexOf(" (", StringComparison.Ordinal);
            return paren > 0 && name.EndsWith(")") ? name.Substring(0, paren) : name;
        }

        static IEnumerable<INamedTypeSymbol> SourceTypes(INamespaceSymbol ns)
        {
            foreach (var type in ns.GetTypeMembers())
                foreach (var t in WithNested(type))
                    yield return t;
            foreach (var inner in ns.GetNamespaceMembers())
                foreach (var t in SourceTypes(inner))
                    yield return t;
        }

        static IEnumerable<INamedTypeSymbol> WithNested(INamedTypeSymbol type)
        {
            yield return type;
            foreach (var nested in type.GetTypeMembers())
                foreach (var t in WithNested(nested))
                    yield return t;
        }

        /// <summary>Files the build writes (obj folders, *.g.cs) hold no code anyone wrote.</summary>
        internal static bool IsGenerated(string path) =>
            string.IsNullOrEmpty(path)
            || path.IndexOf("\\obj\\", StringComparison.OrdinalIgnoreCase) >= 0
            || path.IndexOf("/obj/", StringComparison.OrdinalIgnoreCase) >= 0
            || path.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".g.i.cs", StringComparison.OrdinalIgnoreCase);

        static Location MainLocation(ISymbol symbol)
        {
            Location fallback = null;
            foreach (var loc in symbol.Locations)
            {
                if (!loc.IsInSource)
                    continue;
                if (!IsGenerated(loc.SourceTree?.FilePath))
                    return loc;
                fallback = fallback ?? loc;
            }
            return fallback;
        }

        static void AddType(Context c, INamedTypeSymbol symbol, string project)
        {
            if (symbol.IsImplicitlyDeclared)
                return;
            var loc = MainLocation(symbol);
            if (loc == null || IsGenerated(loc.SourceTree?.FilePath))
                return;
            var key = symbol.GetDocumentationCommentId();
            if (key == null || c.TypesByKey.ContainsKey(key))
                return;
            if (c.Model.Types.Count >= MaxTypes)
            {
                c.Model.Truncated = true;
                return;
            }

            var file = Relative(c, loc.SourceTree.FilePath);
            var type = new CodeType
            {
                Id = c.NextId++,
                Name = TypeName(symbol),
                Namespace = symbol.ContainingNamespace == null || symbol.ContainingNamespace.IsGlobalNamespace ? "" : symbol.ContainingNamespace.ToDisplayString(),
                Kind = KindOf(symbol),
                Access = Access(symbol.DeclaredAccessibility),
                Modifiers = Modifiers(symbol),
                Project = project,
                File = file,
                Line = loc.GetLineSpan().StartLinePosition.Line,
            };
            c.TypesByKey[key] = type;
            c.Model.Types.Add(type);
            c.Declared.Add((symbol, type));

            foreach (var member in symbol.GetMembers())
            {
                if (member.IsImplicitlyDeclared || member is INamedTypeSymbol)
                    continue;
                var kind = MemberKind(member);
                var mloc = kind == null ? null : MainLocation(member);
                // members only the build declares (XAML's InitializeComponent, named controls, Main) are not the author's
                if (mloc != null && IsGenerated(mloc.SourceTree?.FilePath))
                    continue;
                var mkey = mloc == null ? null : member.GetDocumentationCommentId();
                if (mkey == null || c.MembersByKey.ContainsKey(mkey))
                    continue;
                var mfile = Relative(c, mloc.SourceTree.FilePath);
                var m = new CodeMember
                {
                    Id = c.NextId++,
                    Name = member is IMethodSymbol ms && (ms.MethodKind == MethodKind.Constructor || ms.MethodKind == MethodKind.StaticConstructor) ? symbol.Name : member.Name,
                    Kind = kind,
                    Signature = Signature(member),
                    Access = Access(member.DeclaredAccessibility),
                    Static = member.IsStatic && kind != "value",
                    Abstract = member.IsAbstract,
                    File = mfile == file ? null : mfile,
                    Line = mloc.GetLineSpan().StartLinePosition.Line,
                    Entry = member is IMethodSymbol method ? EntryKind(method) : null,
                    Returns = ValueType(member),
                    Parameters = member is IMethodSymbol withArgs && withArgs.Parameters.Length > 0 ? withArgs.Parameters.Select(p => p.Name).ToList() : null,
                };
                c.MembersByKey[mkey] = m.Id;
                c.Members[m.Id] = m;
                type.Members.Add(m);
                if (m.Entry == "event")
                    c.Handlers[symbol.ToDisplayString() + "." + member.Name] = m;
            }
        }

        /// <summary>The base type, interfaces and field/property types that are themselves in the model.</summary>
        static void Relate(Context c, INamedTypeSymbol symbol, CodeType type)
        {
            var related = new HashSet<int> { type.Id };
            if (symbol.BaseType != null && Find(c, symbol.BaseType) is CodeType b)
            {
                type.Base = b.Id;
                related.Add(b.Id);
            }
            foreach (var i in symbol.Interfaces)
                if (Find(c, i) is CodeType it && related.Add(it.Id))
                    (type.Interfaces = type.Interfaces ?? new List<int>()).Add(it.Id);

            foreach (var member in symbol.GetMembers())
            {
                ITypeSymbol t = member is IFieldSymbol f && !f.IsImplicitlyDeclared ? f.Type
                    : member is IPropertySymbol p ? p.Type
                    : null;
                if (t == null)
                    continue;
                foreach (var used in Mentioned(t))
                    if (Find(c, used) is CodeType u && related.Add(u.Id))
                        (type.Uses = type.Uses ?? new List<int>()).Add(u.Id);
            }
        }

        /// <summary>Named types inside a type: List&lt;Order[]&gt; mentions List and Order.</summary>
        static IEnumerable<INamedTypeSymbol> Mentioned(ITypeSymbol t)
        {
            switch (t)
            {
                case IArrayTypeSymbol array:
                    foreach (var x in Mentioned(array.ElementType))
                        yield return x;
                    break;
                case INamedTypeSymbol named:
                    yield return named;
                    foreach (var arg in named.TypeArguments)
                        foreach (var x in Mentioned(arg))
                            yield return x;
                    break;
            }
        }

        static CodeType Find(Context c, INamedTypeSymbol t)
        {
            var key = t.OriginalDefinition.GetDocumentationCommentId();
            return key != null && c.TypesByKey.TryGetValue(key, out var type) ? type : null;
        }

        static int? FindMember(Context c, ISymbol s)
        {
            var key = s.OriginalDefinition.GetDocumentationCommentId();
            return key != null && c.MembersByKey.TryGetValue(key, out var id) ? id : (int?)null;
        }

        /// <summary>Every call and object creation in the file whose target is a member of the model.</summary>
        static async Task ReadCallsAsync(Context c, Compilation compilation, SyntaxTree tree, CancellationToken ct)
        {
            var root = await tree.GetRootAsync(ct).ConfigureAwait(false);
            SemanticModel model = null;
            foreach (var node in root.DescendantNodes())
            {
                if (node is AssignmentExpressionSyntax add && add.IsKind(SyntaxKind.AddAssignmentExpression))
                {
                    model = model ?? compilation.GetSemanticModel(tree);
                    LabelSubscription(c, model, add, ct);
                    continue;
                }
                if (!(node is InvocationExpressionSyntax || node is ObjectCreationExpressionSyntax || node is ImplicitObjectCreationExpressionSyntax || node is ConstructorInitializerSyntax))
                    continue;
                model = model ?? compilation.GetSemanticModel(tree);
                var info = model.GetSymbolInfo(node, ct);
                // an unresolved overload still names its candidates; the first is the best guess
                var target = (info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
                if (target == null)
                    continue;
                target = target.ReducedFrom ?? target;
                var callee = FindMember(c, target);
                if (callee == null)
                    continue;
                var caller = Caller(model.GetEnclosingSymbol(node.SpanStart, ct));
                var from = caller == null ? null : FindMember(c, caller);
                if (from == null)
                    continue;
                long key = ((long)from.Value << 32) | (uint)callee.Value;
                c.Calls[key] = c.Calls.TryGetValue(key, out var n) ? n + 1 : 1;
            }
        }

        /// <summary>The member a call belongs to: lambdas and local functions count for the member around them, accessors for their property.</summary>
        static ISymbol Caller(ISymbol enclosing)
        {
            while (enclosing is IMethodSymbol m && (m.MethodKind == MethodKind.AnonymousFunction || m.MethodKind == MethodKind.LocalFunction))
                enclosing = m.ContainingSymbol;
            if (enclosing is IMethodSymbol accessor && accessor.AssociatedSymbol != null)
                return accessor.AssociatedSymbol;
            return enclosing;
        }

        static string Relative(Context c, string path) => Relative(c.Root, path);

        /// <summary>A path relative to the mapped folder with "/" when inside it, otherwise the full path.</summary>
        internal static string Relative(string root, string path)
        {
            if (string.IsNullOrEmpty(path))
                return "";
            if (root != null && path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return path.Substring(root.Length + 1).Replace('\\', '/');
            return path;
        }

        /// <summary>
        /// Where a flow can start: event handlers (object sender, an EventArgs), commands, web API actions, tests and
        /// Main. Null for an ordinary method.
        /// </summary>
        static string EntryKind(IMethodSymbol m)
        {
            if (m.MethodKind != MethodKind.Ordinary)
                return null;
            foreach (var attribute in m.GetAttributes())
            {
                var name = attribute.AttributeClass?.Name ?? "";
                if (name == "RelayCommandAttribute" || name == "RelayCommand")
                    return "command";
                if (name.StartsWith("Http") || name == "RouteAttribute")
                    return "action";
                if (name == "FactAttribute" || name == "TheoryAttribute" || name == "TestAttribute" || name == "TestMethodAttribute" || name == "TestCaseAttribute")
                    return "test";
            }
            if (m.Parameters.Length == 2 && m.Parameters[0].Type.SpecialType == SpecialType.System_Object && Inherits(m.Parameters[1].Type, "EventArgs"))
                return "event";
            if (m.IsStatic && m.Name == "Main")
                return "main";
            if (m.Name == "Execute" && m.ContainingType.AllInterfaces.Any(i => i.Name == "ICommand"))
                return "command";
            if (m.DeclaredAccessibility == Accessibility.Public && !m.IsStatic && Inherits(m.ContainingType, "ControllerBase"))
                return "action";
            return null;
        }

        static bool Inherits(ITypeSymbol t, string baseName)
        {
            for (var b = t; b != null; b = b.BaseType)
                if (b.Name == baseName)
                    return true;
            return false;
        }

        /// <summary>"button1.Click += Button1_Click" labels the handler with the control and event it serves.</summary>
        static void LabelSubscription(Context c, SemanticModel model, AssignmentExpressionSyntax add, CancellationToken ct)
        {
            var right = add.Right is ObjectCreationExpressionSyntax wrap && wrap.ArgumentList?.Arguments.Count == 1 ? wrap.ArgumentList.Arguments[0].Expression : add.Right;
            if (!(model.GetSymbolInfo(right, ct).Symbol is IMethodSymbol handler))
                return;
            var id = FindMember(c, handler);
            if (id == null || !c.Members.TryGetValue(id.Value, out var m) || m.Ui != null)
                return;
            var target = add.Left.ToString();
            if (target.StartsWith("this."))
                target = target.Substring(5);
            int dot = target.LastIndexOf('.');
            m.Ui = dot > 0 ? target.Substring(0, dot) + " · " + target.Substring(dot + 1) : target;
            m.Entry = m.Entry ?? "event";
        }

        static readonly System.Xml.Linq.XNamespace XamlNs = "http://schemas.microsoft.com/winfx/2006/xaml";

        /// <summary>Labels event handlers with the XAML element that names them: Button "Convert" · Click.</summary>
        static void ReadXaml(Context c, string dir, CancellationToken ct)
        {
            if (c.Handlers.Count == 0 || dir == null || !Directory.Exists(dir))
                return;
            var pending = new Stack<string>();
            pending.Push(dir);
            while (pending.Count > 0)
            {
                ct.ThrowIfCancellationRequested();
                var folder = pending.Pop();
                string[] files, folders;
                try
                {
                    files = Directory.GetFiles(folder, "*.xaml");
                    folders = Directory.GetDirectories(folder);
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { continue; }
                foreach (var sub in folders)
                {
                    var name = Path.GetFileName(sub);
                    if (!name.Equals("bin", StringComparison.OrdinalIgnoreCase) && !name.Equals("obj", StringComparison.OrdinalIgnoreCase) && !name.StartsWith("."))
                        pending.Push(sub);
                }
                foreach (var file in files)
                    ReadXamlFile(c, file);
            }
        }

        static void ReadXamlFile(Context c, string file)
        {
            System.Xml.Linq.XDocument doc;
            try { doc = System.Xml.Linq.XDocument.Load(file); }
            catch (Exception ex) when (ex is IOException || ex is System.Xml.XmlException || ex is UnauthorizedAccessException) { return; }
            var cls = (string)doc.Root?.Attribute(XamlNs + "Class");
            if (cls == null)
                return;
            foreach (var element in doc.Root.DescendantsAndSelf())
            {
                foreach (var attribute in element.Attributes())
                {
                    if (attribute.IsNamespaceDeclaration || attribute.Name.Namespace != System.Xml.Linq.XNamespace.None)
                        continue;
                    if (!c.Handlers.TryGetValue(cls + "." + attribute.Value, out var m) || m.Ui != null)
                        continue;
                    var name = (string)element.Attribute(XamlNs + "Name") ?? (string)element.Attribute("Name");
                    var text = new[] { "Content", "Header", "Text", "Title", "ToolTip" }
                        .Select(a => (string)element.Attribute(a)).FirstOrDefault(v => !string.IsNullOrEmpty(v) && !v.StartsWith("{"));
                    var what = text ?? name;
                    m.Ui = element.Name.LocalName + (what != null ? " \u201c" + what + "\u201d" : "") + " · " + attribute.Name.LocalName;
                }
            }
        }

        static string TypeName(INamedTypeSymbol t)
        {
            var name = t.Name;
            if (t.TypeParameters.Length > 0)
                name += "<" + string.Join(", ", t.TypeParameters.Select(p => p.Name)) + ">";
            return t.ContainingType != null ? TypeName(t.ContainingType) + "." + name : name;
        }

        static string KindOf(INamedTypeSymbol t)
        {
            if (t.IsRecord)
                return t.IsValueType ? "record struct" : "record";
            switch (t.TypeKind)
            {
                case TypeKind.Interface: return "interface";
                case TypeKind.Struct: return "struct";
                case TypeKind.Enum: return "enum";
                case TypeKind.Delegate: return "delegate";
                default: return "class";
            }
        }

        static string Modifiers(INamedTypeSymbol t)
        {
            if (t.TypeKind != TypeKind.Class)
                return null;
            if (t.IsStatic) return "static";
            if (t.IsAbstract) return "abstract";
            if (t.IsSealed) return "sealed";
            return null;
        }

        static string MemberKind(ISymbol member)
        {
            switch (member)
            {
                case IMethodSymbol m:
                    switch (m.MethodKind)
                    {
                        case MethodKind.Ordinary: return "method";
                        case MethodKind.Constructor:
                        case MethodKind.StaticConstructor: return "ctor";
                        case MethodKind.UserDefinedOperator:
                        case MethodKind.Conversion: return "operator";
                        case MethodKind.Destructor: return "method";
                        default: return null; // accessors are listed through their property or event
                    }
                case IPropertySymbol _: return "prop";
                case IFieldSymbol f: return f.ContainingType.TypeKind == TypeKind.Enum ? "value" : "field";
                case IEventSymbol _: return "event";
                default: return null;
            }
        }

        static string Signature(ISymbol member)
        {
            switch (member)
            {
                case IMethodSymbol m:
                    var args = string.Join(", ", m.Parameters.Select(p => p.Type.ToDisplayString(TypeFormat) + " " + p.Name));
                    var ret = m.ReturnsVoid || m.MethodKind == MethodKind.Constructor || m.MethodKind == MethodKind.StaticConstructor ? "" : ": " + m.ReturnType.ToDisplayString(TypeFormat);
                    return "(" + args + ")" + ret;
                case IPropertySymbol p:
                    return (p.IsIndexer ? "[" + string.Join(", ", p.Parameters.Select(x => x.Type.ToDisplayString(TypeFormat) + " " + x.Name)) + "]" : "") + ": " + p.Type.ToDisplayString(TypeFormat);
                case IFieldSymbol f:
                    return f.ContainingType.TypeKind == TypeKind.Enum ? "" : ": " + f.Type.ToDisplayString(TypeFormat);
                case IEventSymbol e:
                    return ": " + e.Type.ToDisplayString(TypeFormat);
                default:
                    return "";
            }
        }

        /// <summary>The type of what a member holds or gives back, or null for void methods and constructors.</summary>
        static string ValueType(ISymbol member)
        {
            switch (member)
            {
                case IMethodSymbol m when !m.ReturnsVoid && m.MethodKind != MethodKind.Constructor && m.MethodKind != MethodKind.StaticConstructor:
                    return m.ReturnType.ToDisplayString(TypeFormat);
                case IPropertySymbol p:
                    return p.Type.ToDisplayString(TypeFormat);
                case IFieldSymbol f when f.ContainingType.TypeKind != TypeKind.Enum:
                    return f.Type.ToDisplayString(TypeFormat);
                default:
                    return null;
            }
        }

        static string Access(Accessibility a)
        {
            switch (a)
            {
                case Accessibility.Public: return "public";
                case Accessibility.Internal: return "internal";
                case Accessibility.Protected: return "protected";
                case Accessibility.ProtectedOrInternal: return "protected internal";
                case Accessibility.ProtectedAndInternal: return "private protected";
                default: return "private";
            }
        }
    }
}
