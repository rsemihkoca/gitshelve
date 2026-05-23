# Git Shelve — IntelliJ-style stash for VSCode & Cursor

A minimal **IntelliJ-style Shelve** for Git, brought to VSCode and Cursor. Set aside uncommitted changes as patch files — an alternative to `git stash` that lives outside Git's stash stack and survives branch switches.

Search keywords: `shelve`, `stash`, `git stash`, `intellij`, `shelf`.

## Why not `git stash`?

`git stash` is tied to your repo's stash stack and can be awkward across branch switches and merges. IntelliJ's "Shelf" stores changes as plain `.patch` files in your workspace — easy to inspect, share, and re-apply anywhere.

## Features

- **Shelve Changes** — saves your current uncommitted changes (staged + unstaged) as a named patch under `.vscode/shelves/<name>.patch`, then reverts your working tree.
- **Unshelve** — re-applies a shelved patch onto your working tree (uses `git apply --3way`, so partial conflicts are marked, not lost).
- **View Diff** — opens the `.patch` file directly.
- **Delete Shelf** — removes the patch from disk.
- A dedicated **Shelf** view in the Source Control panel, right below "Changes".

## Usage

1. Open the **Source Control** panel.
2. Find the **Shelf** view (below "Changes").
3. Click the archive icon in the view title to shelve your current changes — give it a name.
4. Right-click any shelf entry to **Unshelve** or **Delete**. Click an entry to view its diff.

## Storage

Shelves are stored as patch files inside your workspace at:

```
.vscode/shelves/<name>.patch
```

Add this line to your `.gitignore` if you don't want personal WIP shelves committed:

```
.vscode/shelves/
```

## Limitations

- **Tracked files only.** Newly added (untracked) files are not currently shelved — they remain in your working tree after shelve.
- Binary files are included via `git diff --binary`.

## Commands

| Command | Description |
|---|---|
| `Shelve Changes` | Save current uncommitted changes as a named shelf and revert the working tree. |
| `Unshelve` | Apply a shelved patch back to the working tree. |
| `Delete Shelf` | Remove a shelf from disk. |
| `View Diff` | Open the raw `.patch` file. |
| `Refresh` | Reload the shelf list. |

## License

MIT
