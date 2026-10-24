using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Newtonsoft.Json;

namespace Codegram
{
    /// <summary>A file or folder in the map. Short JSON names keep the message small on big repositories.</summary>
    sealed class Entry
    {
        [JsonProperty("n")] public string Name;
        /// <summary>Language id of a file (see <see cref="FolderScanner"/>); null for folders.</summary>
        [JsonProperty("g", NullValueHandling = NullValueHandling.Ignore)] public string Lang;
        [JsonProperty("c", DefaultValueHandling = DefaultValueHandling.Ignore)] public long Lines;
        [JsonProperty("b", DefaultValueHandling = DefaultValueHandling.Ignore)] public long Bytes;
        /// <summary>Children of a folder; null for files.</summary>
        [JsonProperty("k", NullValueHandling = NullValueHandling.Ignore)] public List<Entry> Kids;
    }

    sealed class ScanResult
    {
        public Entry Root;
        public int Files;
        public bool Truncated;
        public double Seconds;
    }

    /// <summary>
    /// Walks a folder into a tree of files with their language, size and line count. Generated and tool folders
    /// (bin, obj, node_modules, target, .git ...) and the patterns in the root .gitignore are left out.
    /// </summary>
    static class FolderScanner
    {
        public const int MaxFiles = 200_000;
        /// <summary>Larger files are counted by size only: they are almost always generated.</summary>
        const long MaxCountBytes = 4 * 1024 * 1024;

        static readonly HashSet<string> SkipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".git", ".vs", ".svn", ".hg", ".idea", "bin", "obj", "node_modules", "target", "packages", "__pycache__",
            ".venv", "venv", ".mypy_cache", ".pytest_cache", ".next", ".nuget", "TestResults",
        };

        /// <summary>Extension to language id. Files with these extensions are text, so their lines are counted.</summary>
        static readonly Dictionary<string, string> Langs = Build(
            ("cs", ".cs .csx"),
            ("ts", ".ts .tsx .mts .cts"),
            ("js", ".js .jsx .mjs .cjs"),
            ("py", ".py .pyi .pyw"),
            ("rs", ".rs"),
            ("cpp", ".c .h .cpp .hpp .cc .cxx .hh .hxx .inl .ixx"),
            ("web", ".html .htm .css .scss .sass .less .razor .cshtml .vue .svelte .xaml"),
            ("data", ".json .xml .yaml .yml .toml .ini .config .csproj .vbproj .fsproj .vcxproj .sln .slnx .props .targets .vsct .vsixmanifest .resx .sql .proto .graphql"),
            ("doc", ".md .markdown .txt .rst .adoc"),
            ("script", ".ps1 .psm1 .psd1 .sh .bash .bat .cmd"),
            ("code", ".vb .fs .fsx .go .java .kt .kts .swift .rb .php .lua .dart .scala .r .m .mm .zig .hs .ex .exs .clj .cmake"));

        static Dictionary<string, string> Build(params (string id, string exts)[] groups)
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (id, exts) in groups)
                foreach (var ext in exts.Split(' '))
                    map[ext] = id;
            return map;
        }

        sealed class State
        {
            public CancellationToken Ct;
            public GitIgnore Ignore;
            public int Files;
            public bool Truncated;
            public readonly byte[] Buffer = new byte[64 * 1024];
        }

        public static ScanResult Scan(string root, CancellationToken ct)
        {
            var watch = Stopwatch.StartNew();
            var s = new State { Ct = ct, Ignore = GitIgnore.Load(root) };
            var tree = Walk(new DirectoryInfo(root), "", s);
            return new ScanResult { Root = tree, Files = s.Files, Truncated = s.Truncated, Seconds = watch.Elapsed.TotalSeconds };
        }

        /// <summary>True when a change at <paramref name="relative"/> cannot change the map (it is inside a skipped folder).</summary>
        public static bool IsSkipped(string relative)
        {
            foreach (var part in relative.Split('\\', '/'))
                if (SkipDirs.Contains(part))
                    return true;
            return false;
        }

        static Entry Walk(DirectoryInfo dir, string rel, State s)
        {
            s.Ct.ThrowIfCancellationRequested();
            var entry = new Entry { Name = dir.Name, Kids = new List<Entry>() };
            FileSystemInfo[] items;
            try { items = dir.GetFileSystemInfos(); }
            catch (Exception ex) when (ex is UnauthorizedAccessException || ex is IOException || ex is System.Security.SecurityException) { return entry; }
            Array.Sort(items, (a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));

            foreach (var item in items)
            {
                // links and junctions can loop back on themselves
                if ((item.Attributes & FileAttributes.ReparsePoint) != 0)
                    continue;
                var childRel = rel.Length == 0 ? item.Name : rel + "/" + item.Name;
                if (item is DirectoryInfo d)
                {
                    if (SkipDirs.Contains(d.Name) || s.Ignore.Matches(childRel, d.Name, true))
                        continue;
                    var kid = Walk(d, childRel, s);
                    // an empty folder has no area on a map
                    if (kid.Kids.Count > 0)
                        entry.Kids.Add(kid);
                }
                else if (item is FileInfo f)
                {
                    if (s.Ignore.Matches(childRel, f.Name, false))
                        continue;
                    if (s.Files >= MaxFiles)
                    {
                        s.Truncated = true;
                        continue;
                    }
                    s.Files++;
                    entry.Kids.Add(ReadFile(f, s));
                }
            }
            return entry;
        }

        static Entry ReadFile(FileInfo f, State s)
        {
            long bytes = 0;
            try { bytes = f.Length; } catch (IOException) { }
            var lang = Langs.TryGetValue(f.Extension, out var id) ? id : "other";
            long lines = lang != "other" && bytes > 0 && bytes <= MaxCountBytes ? CountLines(f.FullName, s.Buffer) : 0;
            return new Entry { Name = f.Name, Lang = lang, Lines = lines, Bytes = bytes };
        }

        /// <summary>Lines in a text file; 0 when it cannot be read or holds a zero byte (binary).</summary>
        static long CountLines(string path, byte[] buffer)
        {
            try
            {
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.SequentialScan))
                {
                    long lines = 0;
                    byte last = (byte)'\n';
                    bool first = true;
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (first && Array.IndexOf(buffer, (byte)0, 0, Math.Min(read, 8000)) >= 0)
                            return 0;
                        first = false;
                        for (int i = 0; i < read; i++)
                            if (buffer[i] == (byte)'\n')
                                lines++;
                        last = buffer[read - 1];
                    }
                    return last == (byte)'\n' ? lines : lines + 1;
                }
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                return 0;
            }
        }
    }

    /// <summary>
    /// The common part of .gitignore at the root of the folder: names and globs (*, **, ?), "/" anchoring and
    /// folder-only patterns. Negations ("!") are not supported and are skipped.
    /// </summary>
    sealed class GitIgnore
    {
        readonly List<(Regex pattern, bool anchored, bool dirOnly)> rules = new List<(Regex, bool, bool)>();

        public static GitIgnore Load(string root)
        {
            var ignore = new GitIgnore();
            var path = Path.Combine(root, ".gitignore");
            if (!File.Exists(path))
                return ignore;
            try
            {
                foreach (var raw in File.ReadAllLines(path))
                {
                    var line = raw.Trim();
                    if (line.Length == 0 || line[0] == '#' || line[0] == '!')
                        continue;
                    bool dirOnly = line.EndsWith("/");
                    line = line.TrimEnd('/');
                    // a slash anywhere but the end ties the pattern to the root
                    bool anchored = line.IndexOf('/') >= 0;
                    line = line.TrimStart('/');
                    if (line.Length == 0)
                        continue;
                    ignore.rules.Add((new Regex("^" + GlobToRegex(line) + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), anchored, dirOnly));
                }
            }
            catch (IOException) { }
            return ignore;
        }

        public bool Matches(string relative, string name, bool isDir)
        {
            foreach (var (pattern, anchored, dirOnly) in rules)
            {
                if (dirOnly && !isDir)
                    continue;
                if (pattern.IsMatch(anchored ? relative : name))
                    return true;
            }
            return false;
        }

        static string GlobToRegex(string glob)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < glob.Length; i++)
            {
                char c = glob[i];
                if (c == '*' && i + 1 < glob.Length && glob[i + 1] == '*')
                {
                    // "**/" matches zero or more folders, a trailing "**" everything below
                    bool slash = i + 2 < glob.Length && glob[i + 2] == '/';
                    sb.Append(slash ? "(?:.*/)?" : ".*");
                    i += slash ? 2 : 1;
                }
                else if (c == '*')
                    sb.Append("[^/]*");
                else if (c == '?')
                    sb.Append("[^/]");
                else
                    sb.Append(Regex.Escape(c.ToString()));
            }
            return sb.ToString();
        }
    }
}
