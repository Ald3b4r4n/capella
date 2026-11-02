import * as vscode from "vscode";
import { ChatPanel } from "./ui/chatPanel.ts";
import { ORIGINAL_SCHEME, OriginalProvider } from "./ui/originalProvider.ts";
import { UpdateMonitor } from "./ui/updateMonitor.ts";
import { setupVoice } from "./ui/voiceBridge.ts";
import { UsageTracker } from "./ui/usageTracker.ts";

export interface CapellaApi {
  chat(): ChatPanel | undefined;
  usage(): UsageTracker;
}

export function activate(context: vscode.ExtensionContext): CapellaApi {
  const output = vscode.window.createOutputChannel("Capella");
  const tracker = new UsageTracker(context);
  const updates = new UpdateMonitor(context);
  const originals = new OriginalProvider();
  ChatPanel.originals = originals;

  // The activity-bar button: its view only holds the welcome buttons from package.json, and showing it opens the chat.
  const launcher = vscode.window.createTreeView("capella.launcher", { treeDataProvider: { getTreeItem: (e: never) => e, getChildren: () => [] } });
  launcher.onDidChangeVisibility((e) => {
    if (e.visible) void vscode.commands.executeCommand("capella.open");
  });

  context.subscriptions.push(
    launcher,
    output,
    tracker,
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originals),
    vscode.commands.registerCommand("capella.open", () => ChatPanel.show(context, output, tracker, updates)),
    vscode.commands.registerCommand("capella.refreshUsage", async () => {
      const session = ChatPanel.get()?.activeSession();
      if (!session) {
        void vscode.window.showInformationMessage("Capella: open the chat first. Usage is read from the running opencode, and Capella never asks the Console by itself.");
        return;
      }
      await tracker.refresh(session, true);
      void vscode.window.showInformationMessage(`Capella usage\n${tracker.summary()}`);
    }),
    vscode.commands.registerCommand("capella.showUsage", async () => {
      const url = tracker.current?.workspace?.usageURL;
      const choice = await vscode.window.showInformationMessage(`Capella usage\n${tracker.summary()}`, "Refresh", ...(url ? ["Open Console usage"] : []), "Open Capella");
      if (choice === "Refresh") await vscode.commands.executeCommand("capella.refreshUsage");
      if (choice === "Open Console usage" && url) await vscode.env.openExternal(vscode.Uri.parse(url));
      if (choice === "Open Capella") await vscode.commands.executeCommand("capella.open");
    }),
    vscode.commands.registerCommand("capella.setupVoice", () => setupVoice(context)),
    vscode.commands.registerCommand("capella.diagnostics", () => ChatPanel.show(context, output, tracker, updates).showDiagnostics()),
  );
  return { chat: () => ChatPanel.get(), usage: () => tracker };
}

export async function deactivate(): Promise<void> {
  await ChatPanel.disposeCurrent();
}
