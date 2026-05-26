import * as vscode from 'vscode';

// Holds the user's clipboard contents from immediately before the most recent
// copy. We don't currently surface a "restore previous clipboard" command, but
// the spec asks that this value be preserved so a future option can use it.
let previousClipboard: string | undefined;

interface CleanOptions {
    trim: boolean;
    removeLeadingSpaces: boolean;
    removeTrailingSpaces: boolean;
    removeTrailingBlankLines: boolean;
    collapseBlankLines: boolean;
}

function readOptions(): CleanOptions {
    const cfg = vscode.workspace.getConfiguration('copyAllFromTerminal');
    return {
        trim: cfg.get<boolean>('trim', true),
        removeLeadingSpaces: cfg.get<boolean>('removeLeadingSpaces', true),
        removeTrailingSpaces: cfg.get<boolean>('removeTrailingSpaces', true),
        removeTrailingBlankLines: cfg.get<boolean>('removeTrailingBlankLines', true),
        collapseBlankLines: cfg.get<boolean>('collapseBlankLines', false),
    };
}

// Pure function — easy to reason about and to test in isolation.
// Order matches the spec: per-line strips → trailing blank lines → collapse → whole-block trim.
export function clean(input: string, opts: CleanOptions): string {
    let lines = input.split(/\r?\n/);

    if (opts.removeLeadingSpaces) {
        lines = lines.map(l => l.replace(/^[ \t]+/, ''));
    }
    if (opts.removeTrailingSpaces) {
        lines = lines.map(l => l.replace(/[ \t]+$/, ''));
    }
    if (opts.removeTrailingBlankLines) {
        while (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }
    }
    if (opts.collapseBlankLines) {
        const collapsed: string[] = [];
        let inBlankRun = false;
        for (const line of lines) {
            if (line === '') {
                if (!inBlankRun) {
                    collapsed.push('');
                    inBlankRun = true;
                }
            } else {
                collapsed.push(line);
                inBlankRun = false;
            }
        }
        lines = collapsed;
    }

    let result = lines.join('\n');
    if (opts.trim) {
        result = result.trim();
    }
    return result;
}

// VS Code's extension API has no method to read the terminal buffer directly
// (Terminal can sendText but not readText), and there's no public API to ask
// "does the terminal have a selection right now?" either. We work around both
// by driving the same UI commands the user would press by hand and reading the
// result from the system clipboard.
//
// Selection detection uses a sentinel: we write a unique marker, run
// copySelection, and read the clipboard back. If it still equals the marker,
// no selection was present (copySelection is a no-op without a selection).
// Otherwise, the clipboard now holds the selected text.
async function runCopy(): Promise<void> {
    const term = vscode.window.activeTerminal;
    if (!term) {
        vscode.window.showWarningMessage('Copy All From Terminal: no active terminal.');
        return;
    }

    try {
        previousClipboard = await vscode.env.clipboard.readText();

        // Ensure the terminal we want to copy from is the focused one. Without
        // a show() call, the commands operate on the currently focused terminal,
        // which is normally the active one — but if focus drifted (e.g. user
        // clicked the status bar item), show() guarantees correctness.
        term.show(true);

        // Sentinel must be unguessable so we never confuse it with real content.
        const sentinel = `__copyAllFromTerminal_sentinel_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
        await vscode.env.clipboard.writeText(sentinel);
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
        let captured = await vscode.env.clipboard.readText();

        // If copySelection didn't change the clipboard, there was no selection.
        // Empty-string check defensively handles a terminal that returned ""
        // (rare but observed in some shell-integration edge cases).
        const hadSelection = captured !== sentinel && captured.length > 0;

        if (!hadSelection) {
            await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
            await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
            captured = await vscode.env.clipboard.readText();
        }

        const cleaned = clean(captured, readOptions());

        await vscode.env.clipboard.writeText(cleaned);
        await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');

        const lineCount = cleaned.length === 0 ? 0 : cleaned.split('\n').length;
        const source = hadSelection ? 'selection' : 'full buffer';
        vscode.window.setStatusBarMessage(
            `Copied ${lineCount} line${lineCount === 1 ? '' : 's'} from ${source}`,
            3000,
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Copy All From Terminal failed: ${msg}`);
    }
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('copyAllFromTerminal.copy', runCopy),
    );

    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'copyAllFromTerminal.copy';
    statusItem.text = '$(copy) Copy Terminal';
    statusItem.tooltip = 'Copy All From Terminal — cleans whitespace per settings';
    statusItem.show();
    context.subscriptions.push(statusItem);
}

export function deactivate(): void {
    // Nothing to clean up — all disposables are registered via context.subscriptions.
}
