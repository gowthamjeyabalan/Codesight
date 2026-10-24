# Codegram

A Visual Studio extension that maps your code into interactive diagrams. It follows the Grapht design system, like Overlay and Grapht.

Five views, switched in the top bar:

- **Flow:** what happens when something starts, in the order it runs. Pick a starting point (buttons and other events, labelled from your XAML or `+=` subscriptions, commands, web API actions, `Main`, or any method) and Codegram follows the code: every call into your own code, opened up into what that method does, with the `if`/`switch` decisions, loops, `try`/`catch`, early returns and throws around them. Calls through an interface or a virtual method show each implementation they can land in. Draw it as a **sequence** diagram (a column per class, calls going down the page) or as numbered **steps** (a flowchart). Double-click a call to open or close it; **Go to call** and **Go to method** jump to the code.
  - **Data:** every call shows what goes in and where its result goes (`ReadAllRows(inputPath) → raw: List<string[]>`); the dashed return arrows carry the returned type. **What it produces** opens up the flow's result types into their fields, nested types and enum values. **Follow** any value (a result, an argument, an input) to see every step that makes it, works on it, takes it, checks it, returns it or throws it, across method boundaries.

- **Classes:** a UML class diagram of the solution's C# (read with Roslyn). Show a namespace, a type and everything it inherits, implements, derives or uses, or the types in a file or folder picked on the map. Boxes list members with their visibility (`+ − # ~`); hollow arrows are inheritance, dashed ones are interfaces, thin ones are fields and properties of another type. Double-click a type for its relations, double-click a member to open it in the editor.
- **Calls:** one method in the middle, its callers on the left and the methods it calls on the right, 1 to 3 steps out, with the number of call sites. Double-click a method to move the graph to it; **Go to code** opens it at its line.
- **Map:** a nested treemap. Area is lines, files or size; colour is the language. Double-click a folder to zoom in, double-click a file to open it. Backspace goes up a level.
- **Tree:** a node-link diagram of folders and files. Drag to pan, scroll to zoom, click a folder to open or close it.
- **Files panel:** browse and search. **Details panel:** language breakdown and the largest files for any selection.
- The C# model is read again a few seconds after you stop typing. Code the build generates (`obj`, `*.g.cs`) is left out.
- Updates by itself when files change. Skips `bin`, `obj`, `node_modules`, `target`, `.git` and the patterns in the root `.gitignore`.
- Follows the Visual Studio theme, or is set to Dark or Light. The panels are see-through over the diagram (Settings: Acrylic or Clear, panel opacity).

Open it from **View > Other Windows > Codegram**, or run `View.Codegram` in the Command Window.

## Building

Visual Studio 2022 or 2026. The build tools come from NuGet, so the Visual Studio extension development workload is only needed to open the project in the IDE and press F5.

```bash
"C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe" Codegram.sln -restore -p:Configuration=Debug
```

This builds `src/Codegram/bin/Debug/Codegram.vsix` and deploys it to the experimental instance (`devenv /rootsuffix Exp`).

## Layout

| Path | What |
|---|---|
| `src/Codegram/CodegramPackage.cs` | Package and the View menu command |
| `src/Codegram/CodegramView.cs` | WebView2 host: solution events, theme, file watcher, open file |
| `src/Codegram/FolderScanner.cs` | Walks the folder, counts lines, reads `.gitignore` |
| `src/Codegram/CodeAnalyzer.cs` | Roslyn: types, members, inheritance, associations, calls and entry points |
| `src/Codegram/FlowAnalyzer.cs` | Roslyn: the ordered flow from one method, with decisions, loops and implementations |
| `src/Codegram/web/` | The diagram UI (plain HTML, CSS and JavaScript, no libraries) |

The web UI runs in a normal browser with made-up sample data, so it can be worked on without Visual Studio. Serve `src/Codegram/web` and open `index.html`.

## Roadmap

1. ~~Folder and file map~~
2. ~~C# class diagrams and call graphs from Roslyn, with click-to-code~~
3. Focus mode, filters, and export to SVG, PNG and Mermaid
4. Speed on large repositories (incremental scans, cache) and a Marketplace release

Later, if wanted: TypeScript/JavaScript, Python and Rust through their language servers. For now the code views are C# only.
