using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Linq;
using System.Windows.Controls;
using Microsoft.CodeAnalysis;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.LanguageServices;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SolutionEvents = Microsoft.VisualStudio.Shell.Events.SolutionEvents;

namespace Codegram
{
    /// <summary>
    /// Hosts the web UI (the web folder next to the extension) and feeds it: the folder of the open solution, the
    /// Visual Studio theme, and a new scan whenever files change. Once the page shows a code view it also gets the C#
    /// model from Roslyn, read again whenever the code changes. The page asks back to open files and to rescan.
    /// </summary>
    sealed class CodegramView : UserControl, IDisposable
    {
        /// <summary>A name that never resolves, so pages are only ever served from the extension folder.</summary>
        const string Host = "codegram.example";

        readonly AsyncPackage package;
        readonly WebView2 web = new WebView2();
        readonly Timer debounce;
        readonly Timer codeDebounce;
        bool started, pageReady, disposed;
        /// <summary>The page has shown a code view, so the C# model is kept up to date.</summary>
        bool codeWanted;
        VisualStudioWorkspace workspace;
        CancellationTokenSource analysis, flow;
        /// <summary>The solution the page's code model was read from, and its member ids, so flows use the same ids.</summary>
        Solution analyzedSolution;
        Dictionary<int, string> analyzedDocIds;
        Dictionary<string, int> analyzedIds;
        /// <summary>Reports the editor's caret to the page, so the views can follow what is being read.</summary>
        readonly System.Windows.Threading.DispatcherTimer caretTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
        string lastCaret;
        /// <summary>The debugger's events; kept in a field, or the COM wrapper is collected and the events stop.</summary>
        EnvDTE.DebuggerEvents debuggerEvents;
        /// <summary>Counts pauses, so a request to open a value from an older pause can be told apart.</summary>
        int pauseId;
        const int MaxFrames = 40, ValuedFrames = 12, MaxValues = 40;
        /// <summary>The folder being mapped, without a trailing separator; null when nothing is open.</summary>
        string root;
        CancellationTokenSource scan;
        FileSystemWatcher watcher;

        public CodegramView(AsyncPackage package)
        {
            this.package = package;
            web.DefaultBackgroundColor = IsDark() ? System.Drawing.Color.FromArgb(0x1c, 0x1c, 0x1f) : System.Drawing.Color.FromArgb(0xe6, 0xe6, 0xea);
            Content = web;
            debounce = new Timer(_ => package.JoinableTaskFactory.RunAsync(async () =>
            {
                await package.JoinableTaskFactory.SwitchToMainThreadAsync();
                StartScan();
            }));
            codeDebounce = new Timer(_ => package.JoinableTaskFactory.RunAsync(async () =>
            {
                await package.JoinableTaskFactory.SwitchToMainThreadAsync();
                StartAnalysis();
            }));

            Loaded += (s, e) =>
            {
                if (started)
                    return;
                started = true;
                _ = package.JoinableTaskFactory.RunAsync(StartAsync);
            };
            VSColorTheme.ThemeChanged += OnThemeChanged;
            SolutionEvents.OnAfterOpenSolution += OnSolutionOpened;
            SolutionEvents.OnAfterCloseSolution += OnSolutionClosed;
            SolutionEvents.OnAfterOpenFolder += OnFolderChanged;
            SolutionEvents.OnAfterCloseFolder += OnFolderChanged;
        }

        static string WebRoot => Path.Combine(Path.GetDirectoryName(typeof(CodegramView).Assembly.Location), "web");

        async Task StartAsync()
        {
            try
            {
                // WebView2 needs a writable profile folder; next to devenv.exe it is not.
                var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Codesight", "WebView2");
                var env = await CoreWebView2Environment.CreateAsync(null, data);
                await web.EnsureCoreWebView2Async(env);
                var core = web.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
#if !DEBUG
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
#endif
                core.SetVirtualHostNameToFolderMapping(Host, WebRoot, CoreWebView2HostResourceAccessKind.Deny);
                core.WebMessageReceived += OnMessage;
                core.NewWindowRequested += (s, e) => e.Handled = true;
                core.Navigate($"https://{Host}/index.html");
            }
            catch (Exception ex) when (!(ex is OperationCanceledException))
            {
                Content = new TextBlock
                {
                    Margin = new System.Windows.Thickness(14),
                    TextWrapping = System.Windows.TextWrapping.Wrap,
                    Text = "Codesight needs the Microsoft Edge WebView2 Runtime to draw its diagrams. Install it and reopen this window.\n\n" + ex.Message,
                };
            }
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            JObject message;
            try { message = JObject.Parse(e.WebMessageAsJson); }
            catch (JsonException) { return; }

            switch ((string)message["type"])
            {
                case "ready":
                    pageReady = true;
                    HookDebugger();
                    caretTimer.Tick -= OnCaretTick;
                    caretTimer.Tick += OnCaretTick;
                    caretTimer.Start();
                    PostTheme();
                    _ = package.JoinableTaskFactory.RunAsync(RefreshRootAsync);
                    break;
                case "rescan":
                    StartScan();
                    break;
                case "open":
                    Open((string)message["path"], -1);
                    break;
                case "goto":
                    Open((string)message["path"], (int?)message["line"] ?? -1);
                    break;
                case "analyze":
                    codeWanted = true;
                    StartAnalysis();
                    break;
                case "flow":
                    StartFlow((int?)message["id"] ?? -1);
                    break;
                case "debug-expand":
                    ExpandValue((int?)message["id"] ?? -1, (int?)message["frame"] ?? -1, (string)message["scope"], message["path"]?.ToObject<string[]>(), (string)message["key"]);
                    break;
                case "save":
                    Save((string)message["name"], (string)message["filter"], (string)message["text"], (string)message["base64"]);
                    break;
                case "copy":
                    try
                    {
                        System.Windows.Clipboard.SetText((string)message["text"] ?? "");
                        Post(new { type = "copied" });
                    }
                    catch (System.Runtime.InteropServices.ExternalException) { Post(new { type = "copied", error = "The clipboard is busy. Try again." }); }
                    break;
            }
        }

        /// <summary>
        /// Opens a file in the editor, at a zero-based <paramref name="line"/> when it is not negative. <paramref name="path"/>
        /// is relative to the root (with "/") or a full path; it must be inside the root or a document of the solution.
        /// </summary>
        void Open(string path, int line)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (root == null || string.IsNullOrEmpty(path))
                return;
            string full;
            try { full = Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(root, path.Replace('/', Path.DirectorySeparatorChar))); }
            catch (Exception ex) when (ex is ArgumentException || ex is NotSupportedException || ex is PathTooLongException) { return; }
            bool inside = full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            bool inSolution = workspace != null && workspace.CurrentSolution.GetDocumentIdsWithFilePath(full).Any();
            if (!(inside || inSolution) || !File.Exists(full))
                return;
            VsShellUtilities.OpenDocument(package, full, Guid.Empty, out _, out _, out var frame, out var view);
            view = view ?? (frame == null ? null : VsShellUtilities.GetTextView(frame));
            if (view != null && line >= 0)
            {
                view.SetCaretPos(line, 0);
                view.CenterLines(line, 1);
            }
        }

        /// <summary>Reads the solution's C# into the page's code model (types, members, calls) on a background thread.</summary>
        void StartAnalysis()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (disposed || !codeWanted)
                return;
            if (workspace == null)
            {
                workspace = (Package.GetGlobalService(typeof(SComponentModel)) as IComponentModel)?.GetService<VisualStudioWorkspace>();
                if (workspace == null)
                {
                    Post(new { type = "code", projects = new string[0], types = new object[0], calls = new int[0], error = "The C# language service is not available." });
                    return;
                }
                workspace.WorkspaceChanged += OnWorkspaceChanged;
            }
            analysis?.Cancel();
            var cts = analysis = new CancellationTokenSource();
            var solution = workspace.CurrentSolution;
            var folder = root;
            Post(new { type = "analyzing" });

            _ = package.JoinableTaskFactory.RunAsync(async () =>
            {
                CodeModel model;
                string error = null;
                try { model = await Task.Run(() => CodeAnalyzer.AnalyzeAsync(solution, folder, cts.Token), cts.Token); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex)
                {
                    model = new CodeModel();
                    error = ex.Message;
                }
                await package.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (cts.IsCancellationRequested)
                    return;
                analyzedSolution = solution;
                analyzedIds = model.MemberIds;
                analyzedDocIds = model.MemberIds.ToDictionary(p => p.Value, p => p.Key);
                Post(new
                {
                    type = "code",
                    projects = model.Projects,
                    types = model.Types,
                    calls = model.Calls,
                    refs = model.Refs,
                    typeRefs = model.TypeRefs,
                    writes = model.Writes,
                    projectRefs = model.ProjectRefs,
                    truncated = model.Truncated,
                    maxTypes = CodeAnalyzer.MaxTypes,
                    seconds = model.Seconds,
                    error,
                });
            });
        }

        // ── debugger snapshot ──

        void HookDebugger()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (debuggerEvents != null || !(Package.GetGlobalService(typeof(EnvDTE.DTE)) is EnvDTE.DTE dte))
                return;
            debuggerEvents = dte.Events.DebuggerEvents;
            debuggerEvents.OnEnterBreakMode += OnBreak;
            debuggerEvents.OnEnterRunMode += OnRun;
            debuggerEvents.OnEnterDesignMode += OnDesign;
            // opened while already paused: show that pause
            if (dte.Debugger.CurrentMode == EnvDTE.dbgDebugMode.dbgBreakMode)
                PostSnapshot("Breakpoint");
        }

        void OnBreak(EnvDTE.dbgEventReason reason, ref EnvDTE.dbgExecutionAction action)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            PostSnapshot(reason.ToString().Replace("dbgEventReason", ""));
        }

        void OnRun(EnvDTE.dbgEventReason reason)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            Post(new { type = "debug", state = "run" });
        }

        void OnDesign(EnvDTE.dbgEventReason reason)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            Post(new { type = "debug", state = "design" });
        }

        /// <summary>
        /// The paused thread's call stack: each frame's method, file and line, and for frames in the solution their
        /// arguments and locals one level deep (deeper levels are read when the page opens them).
        /// </summary>
        void PostSnapshot(string reason)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (disposed || !pageReady || !(Package.GetGlobalService(typeof(EnvDTE.DTE)) is EnvDTE.DTE dte))
                return;
            pauseId++;
            try
            {
                var thread = dte.Debugger.CurrentThread;
                if (thread == null)
                    return;
                var frames = new List<object>();
                int index = 0, valued = 0;
                foreach (EnvDTE.StackFrame frame in thread.StackFrames)
                {
                    if (index >= MaxFrames)
                        break;
                    string file = null;
                    int line = -1;
                    if (frame is EnvDTE90a.StackFrame2 located)
                    {
                        file = located.FileName;
                        line = (int)located.LineNumber - 1;
                    }
                    bool mine = !string.IsNullOrEmpty(file) && root != null && File.Exists(file)
                        && (file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                            || (workspace != null && workspace.CurrentSolution.GetDocumentIdsWithFilePath(file).Any()));
                    bool values = mine && valued++ < ValuedFrames;
                    frames.Add(new
                    {
                        index,
                        fn = frame.FunctionName,
                        file = mine ? CodeAnalyzer.Relative(root, file) : null,
                        line,
                        mine,
                        args = values ? Values(frame.Arguments) : null,
                        locals = values ? Values(frame.Locals) : null,
                    });
                    index++;
                }
                Post(new { type = "debug", state = "break", id = pauseId, reason, thread = thread.Name, frames });
            }
            catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException || ex is InvalidOperationException)
            {
                Post(new { type = "debug", state = "break", id = pauseId, reason, error = "Could not read the call stack: " + ex.Message, frames = new object[0] });
            }
        }

        /// <summary>Name, type and value of each expression, and whether it has members to open.</summary>
        static List<object> Values(EnvDTE.Expressions expressions)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var list = new List<object>();
            try
            {
                foreach (EnvDTE.Expression e in expressions)
                {
                    if (list.Count >= MaxValues)
                        break;
                    string value;
                    bool kids;
                    try
                    {
                        value = e.IsValidValue ? e.Value : "(not available)";
                        kids = e.DataMembers != null && e.DataMembers.Count > 0;
                    }
                    catch (System.Runtime.InteropServices.COMException)
                    {
                        value = "(not available)";
                        kids = false;
                    }
                    if (value != null && value.Length > 300)
                        value = value.Substring(0, 299) + "…";
                    list.Add(new { n = e.Name, t = e.Type, v = value, kids });
                }
            }
            catch (System.Runtime.InteropServices.COMException) { }
            return list;
        }

        /// <summary>The members of one value in a frame of the current pause, found by its path of names.</summary>
        void ExpandValue(int id, int frameIndex, string scope, string[] path, string key)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (id != pauseId || path == null || !(Package.GetGlobalService(typeof(EnvDTE.DTE)) is EnvDTE.DTE dte) || dte.Debugger.CurrentMode != EnvDTE.dbgDebugMode.dbgBreakMode)
            {
                Post(new { type = "debug-children", key, error = "The program is no longer paused there." });
                return;
            }
            try
            {
                var frame = dte.Debugger.CurrentThread.StackFrames.Item(frameIndex + 1);
                var expressions = scope == "args" ? frame.Arguments : frame.Locals;
                foreach (var name in path)
                {
                    EnvDTE.Expression found = null;
                    foreach (EnvDTE.Expression e in expressions)
                        if (e.Name == name) { found = e; break; }
                    if (found == null)
                    {
                        Post(new { type = "debug-children", key, error = "That value is gone." });
                        return;
                    }
                    expressions = found.DataMembers;
                }
                Post(new { type = "debug-children", key, items = Values(expressions) });
            }
            catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException || ex is ArgumentException)
            {
                Post(new { type = "debug-children", key, error = ex.Message });
            }
        }

        /// <summary>Asks where to save an exported diagram and writes it: text (SVG, Mermaid) or base64 (PNG).</summary>
        void Save(string name, string filter, string text, string base64)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dialog = new Microsoft.Win32.SaveFileDialog { FileName = name ?? "Codesight", Filter = filter ?? "All files|*.*", AddExtension = true, OverwritePrompt = true };
            if (dialog.ShowDialog(System.Windows.Window.GetWindow(this)) != true)
                return;
            try
            {
                if (base64 != null)
                    File.WriteAllBytes(dialog.FileName, Convert.FromBase64String(base64));
                else
                    File.WriteAllText(dialog.FileName, text ?? "", new System.Text.UTF8Encoding(false));
                Post(new { type = "saved", path = dialog.FileName });
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is FormatException)
            {
                Post(new { type = "saved", error = ex.Message });
            }
        }

        /// <summary>Sends the file and line of the editor's caret when it moves (zero-based line).</summary>
        void OnCaretTick(object sender, EventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (disposed || !pageReady || root == null || !IsVisible)
                return;
            try
            {
                var dte = Package.GetGlobalService(typeof(EnvDTE.DTE)) as EnvDTE.DTE;
                var doc = dte?.ActiveDocument;
                if (doc == null || !(doc.Selection is EnvDTE.TextSelection selection))
                    return;
                var path = doc.FullName;
                int line = selection.ActivePoint.Line - 1;
                var key = path + "|" + line;
                if (key == lastCaret)
                    return;
                lastCaret = key;
                Post(new { type = "caret", path = CodeAnalyzer.Relative(root, path), line });
            }
            catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException || ex is ArgumentException || ex is InvalidOperationException)
            {
                // a document closing under us: try again next tick
            }
        }

        /// <summary>Follows what runs from the member <paramref name="id"/> of the last code model, on a background thread.</summary>
        void StartFlow(int id)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (disposed || analyzedSolution == null || !analyzedDocIds.TryGetValue(id, out var docId))
            {
                Post(new { type = "flowResult", id, error = "Read the code first." });
                return;
            }
            flow?.Cancel();
            var cts = flow = new CancellationTokenSource();
            var solution = analyzedSolution;
            var ids = analyzedIds;
            var folder = root;

            _ = package.JoinableTaskFactory.RunAsync(async () =>
            {
                FlowStep result = null;
                string error = null;
                try { result = await Task.Run(() => FlowAnalyzer.AnalyzeAsync(solution, docId, ids, folder, cts.Token), cts.Token); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { error = ex.Message; }
                await package.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (cts.IsCancellationRequested)
                    return;
                if (result == null && error == null)
                    error = "This method is no longer in the code.";
                Post(new { type = "flowResult", id, flow = result, budget = FlowAnalyzer.Budget, error });
            });
        }

        void OnWorkspaceChanged(object sender, WorkspaceChangeEventArgs e)
        {
            // typing changes a document many times a second: read again once it has been quiet for a moment
            if (codeWanted && !disposed)
                codeDebounce.Change(e.Kind == WorkspaceChangeKind.DocumentChanged ? 3000 : 1500, Timeout.Infinite);
        }

        /// <summary>Maps the folder of the open solution (or the open folder), or shows the empty state.</summary>
        async Task RefreshRootAsync()
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (disposed)
                return;
            string dir = null;
            if (await package.GetServiceAsync(typeof(SVsSolution)) is IVsSolution solution)
            {
                solution.GetSolutionInfo(out dir, out _, out _);
                if (string.IsNullOrWhiteSpace(dir) && solution.GetProperty((int)__VSPROPID.VSPROPID_SolutionDirectory, out var prop) == 0)
                    dir = prop as string;
            }
            // Open Folder mode has no solution directory; there the solution's name is the folder itself
            if (string.IsNullOrWhiteSpace(dir) && await package.GetServiceAsync(typeof(EnvDTE.DTE)) is EnvDTE.DTE dte)
            {
                var name = dte.Solution?.FullName;
                if (!string.IsNullOrWhiteSpace(name))
                    dir = Directory.Exists(name) ? name : Path.GetDirectoryName(name);
            }
            dir = string.IsNullOrWhiteSpace(dir) ? null : dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (dir != null && !Directory.Exists(dir))
                dir = null;
            if (dir == root && dir != null)
                return;

            root = dir;
            Watch();
            if (root == null)
            {
                scan?.Cancel();
                Post(new { type = "empty" });
            }
            else
                StartScan();
        }

        void StartScan()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (root == null || disposed)
                return;
            scan?.Cancel();
            var cts = scan = new CancellationTokenSource();
            var folder = root;
            Post(new { type = "scanning", root = folder, name = Path.GetFileName(folder) });

            _ = package.JoinableTaskFactory.RunAsync(async () =>
            {
                ScanResult result;
                try { result = await Task.Run(() => FolderScanner.Scan(folder, cts.Token), cts.Token); }
                catch (OperationCanceledException) { return; }
                await package.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (cts.IsCancellationRequested || folder != root)
                    return;
                Post(new
                {
                    type = "tree",
                    root = folder,
                    name = Path.GetFileName(folder),
                    tree = result.Root,
                    files = result.Files,
                    truncated = result.Truncated,
                    maxFiles = FolderScanner.MaxFiles,
                    seconds = result.Seconds,
                });
            });
        }

        /// <summary>Rescans (after a short quiet spell) whenever something in the mapped folder changes.</summary>
        void Watch()
        {
            watcher?.Dispose();
            watcher = null;
            if (root == null)
                return;
            try
            {
                watcher = new FileSystemWatcher(root)
                {
                    IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                    InternalBufferSize = 64 * 1024,
                };
                FileSystemEventHandler changed = (s, e) => Changed(e.FullPath);
                watcher.Changed += changed;
                watcher.Created += changed;
                watcher.Deleted += changed;
                watcher.Renamed += (s, e) => Changed(e.FullPath);
                // the buffer overflowed: too much changed to know what, so look again
                watcher.Error += (s, e) => debounce.Change(1500, Timeout.Infinite);
                watcher.EnableRaisingEvents = true;
            }
            catch (Exception ex) when (ex is ArgumentException || ex is IOException || ex is UnauthorizedAccessException)
            {
                watcher = null;
            }
        }

        void Changed(string fullPath)
        {
            var folder = root;
            if (folder == null || fullPath.Length <= folder.Length)
                return;
            if (FolderScanner.IsSkipped(fullPath.Substring(folder.Length + 1)))
                return;
            debounce.Change(1500, Timeout.Infinite);
        }

        void Post(object message)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (!pageReady || disposed || web.CoreWebView2 == null)
                return;
            web.CoreWebView2.PostWebMessageAsJson(JsonConvert.SerializeObject(message));
        }

        static bool IsDark()
        {
            var c = VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowBackgroundColorKey);
            return 0.299 * c.R + 0.587 * c.G + 0.114 * c.B < 128;
        }

        void PostTheme()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            Post(new { type = "theme", dark = IsDark() });
        }

        void OnThemeChanged(ThemeChangedEventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            PostTheme();
        }

        void OnSolutionOpened(object sender, Microsoft.VisualStudio.Shell.Events.OpenSolutionEventArgs e) => package.JoinableTaskFactory.RunAsync(RefreshRootAsync);
        void OnSolutionClosed(object sender, EventArgs e) => package.JoinableTaskFactory.RunAsync(RefreshRootAsync);
        void OnFolderChanged(object sender, Microsoft.VisualStudio.Shell.Events.FolderEventArgs e) => package.JoinableTaskFactory.RunAsync(RefreshRootAsync);

        public void Dispose()
        {
            // tool windows are disposed on the UI thread, where the debugger's COM events live
            ThreadHelper.ThrowIfNotOnUIThread();
            if (disposed)
                return;
            disposed = true;
            VSColorTheme.ThemeChanged -= OnThemeChanged;
            SolutionEvents.OnAfterOpenSolution -= OnSolutionOpened;
            SolutionEvents.OnAfterCloseSolution -= OnSolutionClosed;
            SolutionEvents.OnAfterOpenFolder -= OnFolderChanged;
            SolutionEvents.OnAfterCloseFolder -= OnFolderChanged;
            caretTimer.Stop();
            if (debuggerEvents != null)
            {
                debuggerEvents.OnEnterBreakMode -= OnBreak;
                debuggerEvents.OnEnterRunMode -= OnRun;
                debuggerEvents.OnEnterDesignMode -= OnDesign;
            }
            scan?.Cancel();
            analysis?.Cancel();
            flow?.Cancel();
            if (workspace != null)
                workspace.WorkspaceChanged -= OnWorkspaceChanged;
            watcher?.Dispose();
            debounce.Dispose();
            codeDebounce.Dispose();
            web.Dispose();
        }
    }
}
