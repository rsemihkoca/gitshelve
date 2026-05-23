import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SHELF_DIR = '.vscode/shelves';

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

function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

async function ensureShelvesIgnored(shelvesDir: string) {
  const gi = path.join(shelvesDir, '.gitignore');
  if (!fs.existsSync(gi)) {
    await fs.promises.writeFile(gi, '*\n');
  }
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

class ShelfRegistry implements vscode.Disposable {
  private sc: vscode.SourceControl;
  private groups = new Map<string, vscode.SourceControlResourceGroup>();
  private mtimes = new Map<string, Date>();

  constructor(rootUri: vscode.Uri) {
    this.sc = vscode.scm.createSourceControl('gitshelve', 'Shelf', rootUri);
    this.sc.inputBox.visible = false;
    this.sc.inputBox.enabled = false;
  }

  async refresh() {
    const root = workspaceRoot();
    if (!root) return;
    const dir = path.join(root, SHELF_DIR);

    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
    this.mtimes.clear();

    if (!fs.existsSync(dir)) {
      this.sc.count = 0;
      return;
    }

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const shelves: { name: string; mtime: Date }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (!fs.existsSync(path.join(full, 'changes.patch'))) continue;
      const stat = await fs.promises.stat(full);
      shelves.push({ name: e.name, mtime: stat.mtime });
    }
    shelves.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    for (const shelf of shelves) {
      const shelfDir = path.join(dir, shelf.name);
      const label = `Changes — ${formatTime(shelf.mtime)}`;
      const group = this.sc.createResourceGroup(shelf.name, label);
      group.hideWhenEmpty = false;

      const afterDir = path.join(shelfDir, 'after');
      const files = fs.existsSync(afterDir) ? await listFilesRecursive(afterDir, '') : [];

      group.resourceStates = files.map(f => ({
        resourceUri: vscode.Uri.file(path.join(afterDir, f)),
        command: {
          command: 'gitshelve.openFile',
          title: 'Open Shelved Diff',
          arguments: [shelfDir, f]
        },
        decorations: {
          tooltip: f
        }
      }));

      this.groups.set(shelf.name, group);
      this.mtimes.set(shelf.name, shelf.mtime);
    }

    this.sc.count = shelves.length;
  }

  shelfDirFromGroup(group: vscode.SourceControlResourceGroup): string | undefined {
    const root = workspaceRoot();
    if (!root) return undefined;
    if (!this.groups.has(group.id)) return undefined;
    return path.join(root, SHELF_DIR, group.id);
  }

  mtimeFromGroup(group: vscode.SourceControlResourceGroup): Date | undefined {
    return this.mtimes.get(group.id);
  }

  dispose() {
    for (const group of this.groups.values()) group.dispose();
    this.sc.dispose();
  }
}

async function shelve(registry: ShelfRegistry) {
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
  await ensureShelvesIgnored(shelvesDir);

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
    await registry.refresh();
    return;
  }

  await registry.refresh();
  vscode.window.showInformationMessage(`Shelved ${tracked.length + untracked.length} file(s)`);
}

async function unshelve(group: vscode.SourceControlResourceGroup | undefined, registry: ShelfRegistry) {
  if (!group) return;
  const root = workspaceRoot();
  if (!root) return;
  const shelfDir = registry.shelfDirFromGroup(group);
  if (!shelfDir) return;

  const patchPath = path.join(shelfDir, 'changes.patch');
  const metaPath = path.join(shelfDir, 'meta.json');

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
      const src = path.join(shelfDir, 'after', f);
      const dst = path.join(root, f);
      if (fs.existsSync(dst)) {
        vscode.window.showWarningMessage(`Skipped (already exists): ${f}`);
        continue;
      }
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      const content = await fs.promises.readFile(src);
      await fs.promises.writeFile(dst, content);
    }

    const mtime = registry.mtimeFromGroup(group);
    vscode.window.showInformationMessage(`Unshelved${mtime ? ` (${formatTime(mtime)})` : ''}`);
    await registry.refresh();
  } catch (e: any) {
    vscode.window.showErrorMessage(`Unshelve failed: ${e.message}`);
  }
}

async function deleteShelf(group: vscode.SourceControlResourceGroup | undefined, registry: ShelfRegistry) {
  if (!group) return;
  const shelfDir = registry.shelfDirFromGroup(group);
  if (!shelfDir) return;
  const mtime = registry.mtimeFromGroup(group);

  const ok = await vscode.window.showWarningMessage(
    `Delete this shelf${mtime ? ` (${formatTime(mtime)})` : ''}?`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  await fs.promises.rm(shelfDir, { recursive: true, force: true });
  await registry.refresh();
}

async function openShelvedFile(shelfDir?: string, relPath?: string) {
  if (!shelfDir || !relPath) return;
  const beforeUri = vscode.Uri.file(path.join(shelfDir, 'before', relPath));
  const afterUri = vscode.Uri.file(path.join(shelfDir, 'after', relPath));
  const title = `${path.basename(relPath)} (Shelved)`;
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
}

export function activate(ctx: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) return;

  const registry = new ShelfRegistry(vscode.Uri.file(root));
  ctx.subscriptions.push(registry);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('gitshelve.shelve', () => shelve(registry)),
    vscode.commands.registerCommand('gitshelve.unshelve', (g: vscode.SourceControlResourceGroup) => unshelve(g, registry)),
    vscode.commands.registerCommand('gitshelve.delete', (g: vscode.SourceControlResourceGroup) => deleteShelf(g, registry)),
    vscode.commands.registerCommand('gitshelve.openFile', (shelfDir: string, relPath: string) => openShelvedFile(shelfDir, relPath)),
    vscode.commands.registerCommand('gitshelve.refresh', () => registry.refresh())
  );

  registry.refresh();

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, `${SHELF_DIR}/**`)
  );
  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => registry.refresh(), 200);
  };
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  ctx.subscriptions.push(watcher);
}

export function deactivate() {}
