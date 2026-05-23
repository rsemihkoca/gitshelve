import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SHELF_DIR = '.vscode/shelves';

class ShelfItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly shelfDir: string,
    public readonly mtime: Date
  ) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'shelf';
    this.description = mtime.toLocaleString();
    this.tooltip = `${name}\n${shelfDir}`;
    this.iconPath = new vscode.ThemeIcon('archive');
  }
}

class ShelfFileItem extends vscode.TreeItem {
  constructor(
    public readonly shelfDir: string,
    public readonly relPath: string
  ) {
    super(path.basename(relPath), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'shelfFile';
    const dir = path.dirname(relPath);
    this.description = dir === '.' ? '' : dir;
    this.tooltip = relPath;
    this.resourceUri = vscode.Uri.file(path.join(shelfDir, 'after', relPath));
    this.command = {
      command: 'gitshelve.openFile',
      title: 'Open Shelved Diff',
      arguments: [this]
    };
  }
}

type TreeNode = ShelfItem | ShelfFileItem;

class ShelfProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh() { this._onDidChange.fire(); }

  getTreeItem(el: TreeNode) { return el; }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const root = workspaceRoot();
    if (!root) return [];

    if (!element) {
      const dir = path.join(root, SHELF_DIR);
      if (!fs.existsSync(dir)) return [];
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const items: ShelfItem[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (!fs.existsSync(path.join(full, 'changes.patch'))) continue;
        const stat = await fs.promises.stat(full);
        items.push(new ShelfItem(e.name, full, stat.mtime));
      }
      return items.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    }

    if (element instanceof ShelfItem) {
      const afterDir = path.join(element.shelfDir, 'after');
      if (!fs.existsSync(afterDir)) return [];
      const files = await listFilesRecursive(afterDir, '');
      return files
        .sort((a, b) => a.localeCompare(b))
        .map(f => new ShelfFileItem(element.shelfDir, f));
    }

    return [];
  }
}

async function listFilesRecursive(dir: string, prefix: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const e of entries) {
    const rel = prefix ? path.posix.join(prefix, e.name) : e.name;
    if (e.isDirectory()) {
      results.push(...await listFilesRecursive(path.join(dir, e.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
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

function execGitBuffer(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn('git', args, { cwd });
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `git ${args.join(' ')} exited ${code}`));
    });
  });
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function snapshotFile(root: string, relPath: string, beforeDir: string, afterDir: string) {
  const beforePath = path.join(beforeDir, relPath);
  const afterPath = path.join(afterDir, relPath);
  await fs.promises.mkdir(path.dirname(beforePath), { recursive: true });
  await fs.promises.mkdir(path.dirname(afterPath), { recursive: true });

  try {
    const beforeContent = await execGitBuffer(['show', `:${relPath}`], root);
    await fs.promises.writeFile(beforePath, beforeContent);
  } catch {
    await fs.promises.writeFile(beforePath, '');
  }

  try {
    const content = await fs.promises.readFile(path.join(root, relPath));
    await fs.promises.writeFile(afterPath, content);
  } catch {
    await fs.promises.writeFile(afterPath, '');
  }
}

async function snapshotUntracked(root: string, relPath: string, beforeDir: string, afterDir: string) {
  const beforePath = path.join(beforeDir, relPath);
  const afterPath = path.join(afterDir, relPath);
  await fs.promises.mkdir(path.dirname(beforePath), { recursive: true });
  await fs.promises.mkdir(path.dirname(afterPath), { recursive: true });
  await fs.promises.writeFile(beforePath, '');
  try {
    const content = await fs.promises.readFile(path.join(root, relPath));
    await fs.promises.writeFile(afterPath, content);
  } catch {
    await fs.promises.writeFile(afterPath, '');
  }
}

async function shelve(provider: ShelfProvider) {
  const root = workspaceRoot();
  if (!root) { vscode.window.showErrorMessage('No workspace open'); return; }

  let diff: string;
  let trackedList: string;
  let untrackedList: string;
  try {
    diff = await execGit(['diff', '--binary'], root);
    trackedList = await execGit(['diff', '--name-only'], root);
    untrackedList = await execGit(['ls-files', '--others', '--exclude-standard'], root);
  } catch (e: any) {
    vscode.window.showErrorMessage(`git failed: ${e.message}`);
    return;
  }

  const tracked = trackedList.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  const untracked = untrackedList.split('\n').map(s => s.trim()).filter(s => s.length > 0);

  if (!diff.trim() && untracked.length === 0) {
    vscode.window.showInformationMessage('No changes to shelve');
    return;
  }

  const shelvesDir = path.join(root, SHELF_DIR);
  await fs.promises.mkdir(shelvesDir, { recursive: true });

  const base = `changes-${timestamp()}`;
  let shelfDir = path.join(shelvesDir, base);
  let i = 2;
  while (fs.existsSync(shelfDir)) {
    shelfDir = path.join(shelvesDir, `${base}-${i}`);
    i++;
  }
  const beforeDir = path.join(shelfDir, 'before');
  const afterDir = path.join(shelfDir, 'after');
  await fs.promises.mkdir(beforeDir, { recursive: true });
  await fs.promises.mkdir(afterDir, { recursive: true });

  for (const f of tracked) {
    await snapshotFile(root, f, beforeDir, afterDir);
  }
  for (const f of untracked) {
    await snapshotUntracked(root, f, beforeDir, afterDir);
  }

  await fs.promises.writeFile(path.join(shelfDir, 'changes.patch'), diff);
  await fs.promises.writeFile(
    path.join(shelfDir, 'meta.json'),
    JSON.stringify({ untracked }, null, 2)
  );

  try {
    if (tracked.length > 0) {
      await execGit(['checkout', '--', '.'], root);
    }
    for (const f of untracked) {
      try { await fs.promises.unlink(path.join(root, f)); } catch {}
    }
  } catch (e: any) {
    vscode.window.showWarningMessage(`Shelf saved but revert failed: ${e.message}`);
    provider.refresh();
    return;
  }

  provider.refresh();
  vscode.window.showInformationMessage(`Shelved: ${path.basename(shelfDir)}`);
}

async function unshelve(item: ShelfItem, provider: ShelfProvider) {
  const root = workspaceRoot();
  if (!root) return;

  const patchPath = path.join(item.shelfDir, 'changes.patch');
  const metaPath = path.join(item.shelfDir, 'meta.json');

  let untracked: string[] = [];
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    untracked = Array.isArray(meta.untracked) ? meta.untracked : [];
  } catch {}

  try {
    const patchContent = await fs.promises.readFile(patchPath, 'utf8');
    if (patchContent.trim()) {
      await execGit(['apply', '--3way', patchPath], root);
    }

    for (const f of untracked) {
      const src = path.join(item.shelfDir, 'after', f);
      const dst = path.join(root, f);
      if (fs.existsSync(dst)) {
        vscode.window.showWarningMessage(`Skipped (already exists): ${f}`);
        continue;
      }
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      const content = await fs.promises.readFile(src);
      await fs.promises.writeFile(dst, content);
    }

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
  await fs.promises.rm(item.shelfDir, { recursive: true, force: true });
  provider.refresh();
}

async function openShelvedFile(item: ShelfFileItem) {
  const beforeUri = vscode.Uri.file(path.join(item.shelfDir, 'before', item.relPath));
  const afterUri = vscode.Uri.file(path.join(item.shelfDir, 'after', item.relPath));
  const title = `${path.basename(item.relPath)} (Shelved)`;
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
}

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new ShelfProvider();
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitshelveView', provider),
    vscode.commands.registerCommand('gitshelve.shelve', () => shelve(provider)),
    vscode.commands.registerCommand('gitshelve.unshelve', (item: ShelfItem) => unshelve(item, provider)),
    vscode.commands.registerCommand('gitshelve.delete', (item: ShelfItem) => deleteShelf(item, provider)),
    vscode.commands.registerCommand('gitshelve.openFile', (item: ShelfFileItem) => openShelvedFile(item)),
    vscode.commands.registerCommand('gitshelve.refresh', () => provider.refresh())
  );

  const root = workspaceRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, `${SHELF_DIR}/**`)
    );
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    watcher.onDidChange(() => provider.refresh());
    ctx.subscriptions.push(watcher);
  }
}

export function deactivate() {}
