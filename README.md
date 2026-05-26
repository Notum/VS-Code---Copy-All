# Copy All From Terminal

One-click copy of the **entire** integrated terminal buffer (including scrollback) to the clipboard, with configurable whitespace cleaning.

The motivating pain point: VS Code's terminal pads its buffer with blank lines after the last prompt. When you `Select All` + `Copy` by hand, you get a long tail of empty lines that has to be hand-stripped before pasting anywhere useful. This extension automates the whole round-trip and exposes the cleaning rules as user settings.

## Installation

From a VSIX you built locally:

```
npm install
npm run compile
npx @vscode/vsce package
code --install-extension copy-all-from-terminal-0.1.0.vsix
```

Or, during development, press <kbd>F5</kbd> from the project root to launch an Extension Development Host with the extension loaded.

## Usage

Trigger the command in any of these ways:

- **Status bar** — click the `$(copy) Copy Terminal` item on the right side of the status bar.
- **Right-click the terminal tab** — the entry appears in the tab's context menu.
- **Right-click inside the terminal** — the entry appears in the terminal context menu.
- **Command palette** — <kbd>Ctrl+Shift+P</kbd> → `Terminal: Copy All From Terminal`.
- **Keybinding** — no default is shipped, but you can bind one to the `copyAllFromTerminal.copy` command in your `keybindings.json`.

After the command runs, the cleaned terminal contents are on your clipboard and a brief status-bar message shows how many lines were copied.

## How it works (and a VS Code API limitation)

The VS Code extension API offers `Terminal.sendText` to write to a terminal but provides **no way to read** terminal text. The blessed workaround is to drive the same UI commands the user would press by hand:

1. Save the current clipboard contents (preserved internally; see *Settings*).
2. Run `workbench.action.terminal.selectAll` then `workbench.action.terminal.copySelection` on the active terminal.
3. Read the resulting text from the system clipboard via `vscode.env.clipboard.readText()`.
4. Apply the configured cleaning options.
5. Write the cleaned text back to the clipboard.
6. Clear the terminal selection.

Because the cleaned terminal contents are what you actually want, the previous clipboard value is **not** restored. The extension does keep the previous value in memory in case a future setting wants to expose a "restore previous clipboard" command.

## Scrollback note

Capture is limited to whatever VS Code currently has in the terminal's scrollback buffer. That's controlled by the `terminal.integrated.scrollback` setting (default `1000` lines). For very long sessions, raise it before you run the command — anything that's already scrolled past the limit is gone.

## Settings

All settings live under `copyAllFromTerminal.*`:

| Setting | Default | Effect |
| --- | --- | --- |
| `trim` | `true` | Trim leading/trailing whitespace of the whole output block (applied last). |
| `removeLeadingSpaces` | `true` | Strip leading spaces and tabs from each line. |
| `removeTrailingSpaces` | `true` | Strip trailing spaces and tabs from each line. |
| `removeTrailingBlankLines` | `true` | Remove empty lines at the end of the output. **This is the key fix** — strips the buffer's trailing blank-line padding. |
| `collapseBlankLines` | `false` | Collapse runs of 2+ blank lines into a single blank line (like `cat -s`). |

Cleaning is applied in this order: per-line leading/trailing strip → remove trailing blank lines → optional collapse → final whole-block trim.

## VS Code Remote

Works transparently over Remote-SSH, WSL, and Dev Containers. All the work is done through host-side commands (`workbench.action.terminal.*`) and `vscode.env.clipboard`, both of which VS Code routes correctly between the remote workspace and the local UI. No remote-specific configuration is required.

## Known limitations

- **No terminal-toolbar button.** VS Code does not expose a contribution point for the terminal panel's top toolbar (the strip with the kill/split icons), so the one-click triggers live in the right-click menus and the status bar instead.
- **Scrollback ceiling.** Content that has already scrolled past `terminal.integrated.scrollback` cannot be recovered.
- **Clipboard is overwritten.** By design — the cleaned terminal text is the intended result.

## License

MIT — see [LICENSE](LICENSE).
