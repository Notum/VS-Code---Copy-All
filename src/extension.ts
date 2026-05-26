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
// (Terminal can sendText but not readText). The blessed workaround is to drive
// the same UI commands the user would press by hand — selectAll + copySelection
// — and read the result from the system clipboard. That's why we briefly
// clobber the clipboard here; the *cleaned* terminal contents are the intended
// final clipboard value, so we don't restore the previous value.
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

        await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');

        const raw = await vscode.env.clipboard.readText();
        const cleaned = clean(raw, readOptions());

        await vscode.env.clipboard.writeText(cleaned);
        await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');

        const lineCount = cleaned.length === 0 ? 0 : cleaned.split('\n').length;
        vscode.window.setStatusBarMessage(`Copied ${lineCount} line${lineCount === 1 ? '' : 's'} from terminal`, 3000);
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
