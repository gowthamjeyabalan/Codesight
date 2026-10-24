using System;
using System.ComponentModel.Design;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace Codegram
{
    /// <summary>
    /// The extension's entry point: registers the Codesight window and the View > Other Windows > Codesight command.
    /// </summary>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [Guid(PackageGuidString)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    // MDI: the diagram opens in the document area, where it has room, instead of beside Solution Explorer.
    [ProvideToolWindow(typeof(CodegramWindow), Style = VsDockStyle.MDI, MultiInstances = false)]
    public sealed class CodegramPackage : AsyncPackage
    {
        public const string PackageGuidString = "aff7ea1f-b886-4cd9-b1b0-4a95b44cbd1e";
        static readonly Guid CommandSet = new Guid("143b2144-7207-4da3-9ed1-e53eb6c13eee");
        const int ShowCodegramId = 0x0100;

        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            if (await GetServiceAsync(typeof(IMenuCommandService)) is OleMenuCommandService commands)
            {
                var id = new CommandID(CommandSet, ShowCodegramId);
                commands.AddCommand(new MenuCommand((s, e) => JoinableTaskFactory.RunAsync(ShowAsync), id));
            }
        }

        async Task ShowAsync()
        {
            var window = await ShowToolWindowAsync(typeof(CodegramWindow), 0, create: true, cancellationToken: DisposalToken);
            if (window?.Frame == null)
                throw new NotSupportedException("Cannot create the Codesight window.");
        }
    }
}
