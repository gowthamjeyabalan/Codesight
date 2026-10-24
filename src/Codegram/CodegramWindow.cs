using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Shell;

namespace Codegram
{
    /// <summary>The Codesight tool window. Its content is a WebView2 that draws the diagrams.</summary>
    [Guid("5991074d-b582-4aa9-a0dc-6710f14e0d56")]
    public sealed class CodegramWindow : ToolWindowPane
    {
        CodegramView view;

        public CodegramWindow() : base(null)
        {
            Caption = "Codesight";
            BitmapImageMoniker = KnownMonikers.DependancyGraph;
        }

        protected override void Initialize()
        {
            base.Initialize();
            view = new CodegramView((AsyncPackage)Package);
            Content = view;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                view?.Dispose();
            base.Dispose(disposing);
        }
    }
}
