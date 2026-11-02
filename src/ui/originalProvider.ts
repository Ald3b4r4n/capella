import * as vscode from "vscode";

export const ORIGINAL_SCHEME = "capella-original";

/**
 * Serves the "before" side of a diff: the text a file had before the chat's first edit, kept in memory by the change
 * tracker. Nothing is written to disk, and a document of this scheme is read-only.
 */
export class OriginalProvider implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();

  /** Registers the text and returns the address to open. `rel` only decorates the tab. */
  put(id: string, rel: string, text: string | null): vscode.Uri {
    this.texts.set(id, text ?? "");
    return vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: "/" + rel, query: id });
  }

  clear(): void {
    this.texts.clear();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.query) ?? "";
  }
}
