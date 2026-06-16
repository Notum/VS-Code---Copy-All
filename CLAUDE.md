# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension ("Copy All From Terminal") that copies terminal text to the
clipboard. Two commands:

- `copyAllFromTerminal.copy` — copies the entire integrated terminal buffer (or
  the current selection), applying configurable whitespace cleaning.
- `copyAllFromTerminal.copyLastAnswer` — extracts just the last Claude Code answer
  from the buffer. **This is what the status-bar item triggers.**

Published as `notum.copy-all-from-terminal`.

## Commands

```
npm install                       # install dev deps (@types/*, typescript)
npm run compile                   # one-shot build: tsc -p ./  → ./out
npm run watch                     # incremental rebuild on save (default build task)
npx @vscode/vsce package          # produce a .vsix for install
code --install-extension copy-all-from-terminal-<version>.vsix
```

- **Debug/run:** press <kbd>F5</kbd> to launch an Extension Development Host. This
  runs the `watch` task first (see `.vscode/launch.json` → `.vscode/tasks.json`).
- **Tests:** there is no test runner configured. `clean()` is `export`ed and pure
  specifically so it can be unit-tested in isolation; wire up a runner before
  adding tests rather than testing through the VS Code host.

## Architecture

Everything lives in `src/extension.ts` (compiled to `out/extension.js`, the
`main` entry). Two concerns worth understanding before editing:

**1. Reading the terminal is a workaround, not an API call.** The VS Code
extension API can *write* to a terminal (`Terminal.sendText`) but cannot *read*
its buffer, and offers no way to query whether a selection exists. `runCopy()`
works around both by driving the same UI commands a user would (`terminal.selectAll`,
`terminal.copySelection`, `terminal.clearSelection`) and reading the result back
through `vscode.env.clipboard`. Selection-vs-full-buffer is detected with a
**sentinel**: write a unique marker to the clipboard, run `copySelection`, and
read back — if the clipboard still equals the sentinel, there was no selection,
so fall back to selecting all. Any change to copy behavior has to preserve this
clipboard round-trip and sentinel dance.

**2. The clipboard is intentionally overwritten.** The cleaned terminal text is
the desired end state, so the previous clipboard value is *not* restored. It is
stashed in the module-level `previousClipboard` only so a future "restore
previous clipboard" command could use it — do not remove that capture.

**3. Last-answer extraction (`extractLastAnswer()`).** A pure function (exported
for testing) that pulls the final Claude Code answer out of a raw buffer. Claude
Code renders each turn as a `●` bullet (answer start) … `✻ <Verb> for <duration>`
footer (e.g. `✻ Brewed for 1m 45s`, printed on completion). A streamed answer
leaves many partial re-renders in scrollback, so the final, complete answer is
the slice from the **last** `●` bullet to the **last** footer. The function finds
the last footer line (`FOOTER_RE` matches the *structure* — leading spinner glyph,
then `<word> for <digit>` — not a specific glyph, and excludes `●`/`❯`/`⎿` so
answer content isn't mistaken for a footer), takes the last bullet before it,
strips the leading `●`, and returns the rest. `runCopyLastAnswer()` always
selects-all (a selection can't locate the answer) and cleans with a fixed option
set that **keeps indentation** (`removeLeadingSpaces: false`, so nested lists/code
survive) while stripping right-edge padding and trailing blanks. If no answer is
found, the user's clipboard is left untouched.

**Cleaning pipeline (`clean()`).** A pure function applying steps in a fixed,
spec-defined order — changing the order changes output:
per-line leading strip → per-line trailing strip → remove trailing blank lines →
collapse blank runs → whole-block trim. Each step is gated by a
`copyAllFromTerminal.*` boolean setting read via `readOptions()`. The trailing-
blank-line removal is the extension's reason to exist (VS Code pads the terminal
buffer with blank lines after the last prompt).

## Conventions

- Settings, the command id (`copyAllFromTerminal.copy`), and the contributed
  menus/configuration live in `package.json` under `contributes`. A new setting
  must be declared there **and** read in `readOptions()` / applied in `clean()`.
- `strict` TypeScript, target ES2022, CommonJS modules.
- No terminal-toolbar button exists because VS Code exposes no contribution point
  for it; triggers are the status bar item, terminal context menus, command
  palette, and an (unbound) keybindable command.
