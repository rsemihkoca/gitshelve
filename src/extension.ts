import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SHELF_DIR = '.vscode/shelves';

class ShelfItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly patchPath: string,
    public readonly mtime: Date
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'shelf';
    this.description = mtime.toLocaleString();
    this.tooltip = `${name}\n${patchPath}`;
    this.iconPath = new vscode.ThemeIcon('archive');
    this.command = { command: 'gitstash.diff', title: 'View Diff', arguments: [this] };
  }
}

class ShelfProvider implements vscode.TreeDataProvider<ShelfItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh() { this._onDidChange.fire(); }

  getTreeItem(el: ShelfItem) { return el; }

  async getChildren(): Promise<ShelfItem[]> {
    const root = workspaceRoot();
    if (!root) return [];
    const dir = path.join(root, SHELF_DIR);
    if (!fs.existsSync(dir)) return [];
    const files = await fs.promises.readdir(dir);
    const items = await Promise.all(
      files
        .filter(f => f.endsWith('.patch'))
        .map(async f => {
          const full = path.join(dir, f);
          const stat = await fs.promises.stat(full);
          return new ShelfItem(f.replace(/\.patch$/, ''), full, stat.mtime);
        })
    );
    return items.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git ${args.join(' ')} exited ${code}`));
    });
  });
}

function sanitize(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9-_ ]/g, '_').slice(0, 80);
}

async function shelve(provider: ShelfProvider) {
  const root = workspaceRoot();
  if (!root) { vscode.window.showErrorMessage('No workspace open'); return; }

  let diff: string;
  try {
    diff = await execGit(['diff', 'HEAD', '--binary'], root);
  } catch (e: any) {
    vscode.window.showErrorMessage(`git diff failed: ${e.message}`);
    return;
  }
  if (!diff.trim()) {
    vscode.window.showInformationMessage('No changes to shelve');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Shelf name',
    placeHolder: 'e.g. wip-login-fix',
    validateInput: v => (v && sanitize(v).length > 0 ? null : 'Name required')
  });
  if (!name) return;

  const dir = path.join(root, SHELF_DIR);
  await fs.promises.mkdir(dir, { recursive: true });

  let base = sanitize(name);
  let patchPath = path.join(dir, `${base}.patch`);
  let i = 2;
  while (fs.existsSync(patchPath)) {
    patchPath = path.join(dir, `${base}-${i}.patch`);
    i++;
  }

  await fs.promises.writeFile(patchPath, diff);

  try {
    await execGit(['checkout', 'HEAD', '--', '.'], root);
  } catch (e: any) {
    vscode.window.showWarningMessage(`Shelf saved but revert failed: ${e.message}`);
    provider.refresh();
    return;
  }

  provider.refresh();
  vscode.window.showInformationMessage(`Shelved: ${path.basename(patchPath, '.patch')}`);
}

async function unshelve(item: ShelfItem, provider: ShelfProvider) {
  const root = workspaceRoot();
  if (!root) return;
  try {
    await execGit(['apply', '--3way', item.patchPath], root);
    vscode.window.showInformationMessage(`Unshelved: ${item.name}`);
    provider.refresh();
  } catch (e: any) {
    vscode.window.showErrorMessage(`Unshelve failed: ${e.message}`);
  }
}

async function deleteShelf(item: ShelfItem, provider: ShelfProvider) {
  const ok = await vscode.window.showWarningMessage(
    `Delete shelf "${item.name}"?`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  await fs.promises.unlink(item.patchPath);
  provider.refresh();
}

async function showDiff(item: ShelfItem) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.patchPath));
  await vscode.window.showTextDocument(doc, { preview: true });
}

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new ShelfProvider();
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitstashShelves', provider),
    vscode.commands.registerCommand('gitstash.shelve', () => shelve(provider)),
    vscode.commands.registerCommand('gitstash.unshelve', (item: ShelfItem) => unshelve(item, provider)),
    vscode.commands.registerCommand('gitstash.delete', (item: ShelfItem) => deleteShelf(item, provider)),
    vscode.commands.registerCommand('gitstash.diff', (item: ShelfItem) => showDiff(item)),
    vscode.commands.registerCommand('gitstash.refresh', () => provider.refresh())
  );

  const root = workspaceRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, `${SHELF_DIR}/*.patch`)
    );
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    watcher.onDidChange(() => provider.refresh());
    ctx.subscriptions.push(watcher);
  }
}

export function deactivate() {}
