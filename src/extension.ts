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

// --- Claude Code answer extraction ----------------------------------------
//
// Claude Code renders each assistant turn in the terminal as:
//
//     ❯ <the user's prompt>
//     ● <the assistant's answer …>
//       <… wrapped/continued, indented two spaces>
//     ✻ Brewed for 1m 45s            <- a "footer" printed once the turn completes
//
// The bullet (U+25CF) marks the start of an assistant message; the footer is a
// frozen spinner glyph followed by "<Verb> for <duration>" ("Brewed for 1m 45s",
// "Cooked for 7m 29s", …). A long, streamed answer leaves many partial re-renders
// in the scrollback, so the *final* complete answer is the text from the LAST
// bullet up to the LAST footer.
const BULLET = '●'; // ●

// A completed-answer footer: a leading spinner glyph (but NOT the ● bullet,
// ❯ prompt, or ⎿ tool-output connector), then "<word> for <digit…>". Matching
// the structure rather than the exact glyph keeps us robust to the spinner frame
// the line happened to freeze on.
const FOOTER_RE = /^\s*(?![●❯⎿])[^\sA-Za-z0-9]{1,2}\s+\w+\s+for\s+\d/u;

// Markers that begin a new logical line — these must NOT be merged into the
// previous line when we un-wrap word-wrapped paragraphs.
const LIST_MARKER_RE = /^\s*(?:[-*•]\s|\d+[.)]\s)/;
// Box-drawing characters (U+2500–257F) — Claude Code draws tables with these.
const BOX_DRAWING_RE = new RegExp('^[\\u2500-\\u257F]');

function startsNewLogicalLine(line: string): boolean {
    return LIST_MARKER_RE.test(line) || BOX_DRAWING_RE.test(line);
}

// Pull the last complete Claude Code answer out of a raw terminal buffer.
// Returns the raw answer slice — the bullet line through the last body line,
// footer excluded — or null if no answer can be located. Pure (unit-testable);
// formatAnswer() does the cosmetic cleanup.
export function extractLastAnswer(buffer: string): string | null {
    const lines = buffer.split(/\r?\n/);

    // End of the answer = the last footer line (exclusive upper bound). If there
    // is no footer (answer still rendering, or it scrolled off), fall back to the
    // last non-blank line so we still copy something sensible.
    let endIdx = lines.length;
    let footerFound = false;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (FOOTER_RE.test(lines[i])) {
            endIdx = i;
            footerFound = true;
            break;
        }
    }
    if (!footerFound) {
        while (endIdx > 0 && lines[endIdx - 1].trim() === '') {
            endIdx--;
        }
    }

    // Start of the answer = the last bullet line before that end. In a buffer
    // full of streamed re-renders this is the final, complete render's bullet.
    let startIdx = -1;
    for (let i = endIdx - 1; i >= 0; i--) {
        if (lines[i].trimStart().startsWith(BULLET)) {
            startIdx = i;
            break;
        }
    }
    if (startIdx === -1) {
        return null;
    }

    return lines.slice(startIdx, endIdx).join('\n');
}

// Turn a raw answer slice (the bullet line plus its word-wrapped body, exactly
// as it sits in the terminal) into clean, paste-ready text:
//   • strip the leading ● bullet;
//   • remove the hanging indent the bullet adds to every continuation/body line
//     (preserving any deeper, nested indentation);
//   • rejoin word-wrapped lines so each paragraph / list item is one logical
//     line — but never merge across list items or table rows;
//   • drop right-edge padding and trailing blanks, and collapse blank runs.
// Pure and exported so it can be unit-tested.
export function formatAnswer(raw: string): string {
    let lines = raw.split(/\r?\n/);

    // The bullet ("● ") sets the message's hanging indent: every wrapped/body
    // line is padded by that many columns to align under the bullet's text.
    const bullet = lines[0]?.match(/^(\s*)●([ \t]?)/);
    const indent = bullet ? bullet[0].length : 0;
    if (bullet) {
        lines[0] = lines[0].slice(indent);
    }

    // Remove the hanging indent (never more than `indent`, so deeper nesting
    // survives) and strip the terminal's right-edge padding from every line.
    const indentRe = new RegExp(`^[ \\t]{0,${indent}}`);
    lines = lines.map((l, i) =>
        (i === 0 ? l : l.replace(indentRe, '')).replace(/[ \t]+$/, ''),
    );

    // Un-wrap: join physical lines that are word-wrap continuations of the line
    // above. A blank line, a list marker, or a table row starts a fresh line.
    const out: string[] = [];
    let current: string | null = null;
    const flush = () => {
        if (current !== null) {
            out.push(current);
            current = null;
        }
    };
    for (const line of lines) {
        if (line === '') {
            flush();
            out.push('');
        } else if (current === null || startsNewLogicalLine(line)) {
            flush();
            current = line;
        } else {
            current += ' ' + line.replace(/^\s+/, '');
        }
    }
    flush();

    // Collapse blank runs, then trim leading/trailing blanks.
    const collapsed: string[] = [];
    for (const line of out) {
        if (line === '' && collapsed[collapsed.length - 1] === '') {
            continue;
        }
        collapsed.push(line);
    }
    while (collapsed.length && collapsed[0] === '') {
        collapsed.shift();
    }
    while (collapsed.length && collapsed[collapsed.length - 1] === '') {
        collapsed.pop();
    }

    return collapsed.join('\n');
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

// Copy just the last Claude Code answer. Unlike runCopy() we always want the
// whole buffer (a selection can't tell us where the last answer is), so we
// select-all unconditionally rather than honoring an existing selection.
async function runCopyLastAnswer(): Promise<void> {
    const term = vscode.window.activeTerminal;
    if (!term) {
        vscode.window.showWarningMessage('Copy Last Answer: no active terminal.');
        return;
    }

    try {
        previousClipboard = await vscode.env.clipboard.readText();
        term.show(true);

        await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
        const buffer = await vscode.env.clipboard.readText();
        await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');

        const raw = extractLastAnswer(buffer);
        const cleaned = raw === null ? '' : formatAnswer(raw);
        if (cleaned === '') {
            // Nothing to copy — leave the user's clipboard as it was.
            await vscode.env.clipboard.writeText(previousClipboard ?? '');
            vscode.window.showWarningMessage(
                'Copy Last Answer: no Claude Code answer found in the terminal.',
            );
            return;
        }

        await vscode.env.clipboard.writeText(cleaned);

        const lineCount = cleaned.length === 0 ? 0 : cleaned.split('\n').length;
        vscode.window.setStatusBarMessage(
            `Copied last answer (${lineCount} line${lineCount === 1 ? '' : 's'})`,
            3000,
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Copy Last Answer failed: ${msg}`);
    }
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('copyAllFromTerminal.copy', runCopy),
        vscode.commands.registerCommand('copyAllFromTerminal.copyLastAnswer', runCopyLastAnswer),
    );

    // The status bar item now copies the last Claude Code answer. The original
    // full-buffer/selection copy stays available via the terminal context menus
    // and the command palette.
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'copyAllFromTerminal.copyLastAnswer';
    statusItem.text = '$(copy) Copy Answer';
    statusItem.tooltip = 'Copy the last Claude Code answer from the terminal';
    statusItem.show();
    context.subscriptions.push(statusItem);
}

export function deactivate(): void {
    // Nothing to clean up — all disposables are registered via context.subscriptions.
}
