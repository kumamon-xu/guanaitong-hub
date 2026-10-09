import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { PreparedUpdate, UpdateInfo, UpdateProgress } from '../src/shared/operations';
import { DEFAULT_UPDATE_FEED, type ReleaseManifest } from '../src/shared/release-config';
import { DATABASE_VERSION } from './database-migrations';
import type { SqliteRepository } from './sqlite-repository';
import { privateDirectory } from './legacy-storage';

const MAX_JSON = 256 * 1024;
const MAX_INSTALLER = 512 * 1024 * 1024;
function httpsURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('发布地址无效');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('发布地址须为不含账户信息的 HTTPS 地址');
  return url.toString();
}
export function compareVersions(first: string, second: string): number {
  const parse = (value: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('发布版本须为 x.y.z');
    const parts = value.split('.').map(Number);
    if (parts.some(value => !Number.isSafeInteger(value))) throw new Error('发布版本无效');
    return parts;
  };
  const a = parse(first), b = parse(second);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function githubRepository(url: string): string | null {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/repos\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/releases\/latest$/);
  return parsed.hostname === 'api.github.com' && !parsed.search && match ? match[1] : null;
}
async function responseBytes(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MAX_JSON) { await response.body?.cancel(); throw new Error('发布清单过大'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('发布清单为空');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > MAX_JSON) throw new Error('发布清单过大'); chunks.push(item.value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
async function jsonResponse(response: Response): Promise<any> {
  const content = await responseBytes(response);
  try { return JSON.parse(content.toString('utf8')); } catch { throw new Error('发布清单格式无效'); }
}
function validateManifest(value:any):ReleaseManifest{
  if(value?.format!=='guanaitong-release'||value.schemaVersion!==1||typeof value.version!=='string'||typeof value.notes!=='string'||value.notes.length>20000||typeof value.publishedAt!=='string'||!Number.isFinite(Date.parse(value.publishedAt))||!value.downloads||typeof value.downloads!=='object'||Array.isArray(value.downloads))throw new Error('发布清单字段无效');
  for(const asset of Object.values(value.downloads) as any[]){
    if(!asset||typeof asset.sha256!=='string'||!/^[0-9a-f]{64}$/i.test(asset.sha256)||(asset.size!==undefined&&(!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>MAX_INSTALLER)))throw new Error('安装包校验值或大小无效');
    httpsURL(asset.url);
  }
  return value;
}
interface DownloadOptions {
  directory: string; openPath(path: string): Promise<string>;
  progress?(value: UpdateProgress): void;
}
export class ReleaseService {
  private checked: UpdateInfo | null = null;
  private prepared: PreparedUpdate | null = null;
  private checking = 0;
  private downloading: AbortController | null = null;
  private installing = false;
  constructor(private readonly version: string, private readonly platform: string, private readonly arch: string,
    private readonly fetcher: typeof fetch, private readonly database: SqliteRepository,
    private readonly openExternal: (url: string) => Promise<void>, private readonly download?: DownloadOptions) {}
  get busy(): boolean { return !!this.downloading || this.installing; }
  private async request(url: string, redirects = false, signal = AbortSignal.timeout(15000), github = false, validateRedirect?: (url: URL) => void): Promise<Response> {
    let target = httpsURL(url);
    for (let count = 0; count <= 5; count++) {
      const api = github && new URL(target).hostname === 'api.github.com';
      const response = await this.fetcher(target, { credentials: 'omit', redirect: 'manual', signal,
        headers: { Accept: api ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'guanaitong-hub/' + this.version, ...(api ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) } });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      if (!redirects || count === 5) throw new Error('更新下载重定向无效');
      const location = response.headers.get('location'); if (!location) throw new Error('更新下载重定向无效');
      target = httpsURL(new URL(location, target).toString());
      if (github && !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(new URL(target).hostname)) throw new Error('GitHub 下载跳转至未知来源');
      validateRedirect?.(new URL(target));
    }
    throw new Error('更新下载重定向过多');
  }
  private async latestGithubManifest(repository: string): Promise<{ manifest: ReleaseManifest; releaseUrl: string }> {
    let tag = '', base = '';
    const response = await this.request(`https://github.com/${repository}/releases/latest/download/release.json`, true, undefined, true, next => {
      if (next.hostname === 'github.com') {
        const match = next.pathname.match(/^\/([^/]+\/[^/]+)\/releases\/download\/(v\d+\.\d+\.\d+)\/release\.json$/);
        if (!match || match[1] !== repository || next.search || (tag && tag !== match[2])) throw new Error('GitHub 正式更新清单来源不一致');
        tag = match[2]; base = next.toString().slice(0, -'release.json'.length);
      } else if (!tag) throw new Error('GitHub 未解析正式版本地址');
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('GitHub 正式更新清单读取失败（HTTP ' + response.status + '）'); }
    if (!tag) { await response.body?.cancel(); throw new Error('GitHub 未解析正式版本地址'); }
    const manifest = validateManifest(await jsonResponse(response));
    if (manifest.version !== tag.slice(1)) throw new Error('更新清单与 GitHub 标签版本不一致');
    const checksumResponse = await this.request(base + 'SHA256SUMS.txt', true, undefined, true);
    if (!checksumResponse.ok) { await checksumResponse.body?.cancel(); throw new Error('GitHub 校验清单读取失败（HTTP ' + checksumResponse.status + '）'); }
    const checksums = new Map<string, string>();
    for (const line of (await responseBytes(checksumResponse)).toString('utf8').split(/\r?\n/).filter(line => line.trim())) {
      const match = line.match(/^([a-f0-9]{64}) {2}([^/\\\r\n]+)$/i);
      if (!match || checksums.has(match[2])) throw new Error('GitHub 校验清单格式无效');
      checksums.set(match[2], match[1].toLowerCase());
    }
    for (const download of Object.values(manifest.downloads)) {
      const url = new URL(httpsURL(download.url)), name = decodeURIComponent(url.pathname.split('/').at(-1)!);
      if (url.toString() !== base + encodeURIComponent(name) || url.search || /[/\\]/.test(name)) throw new Error('GitHub 安装包来源不一致');
      if (!Number.isSafeInteger(download.size) || download.size! < 1 || checksums.get(name) !== download.sha256.toLowerCase()) throw new Error('更新清单与 GitHub 校验清单不一致');
    }
    return { manifest, releaseUrl: `https://github.com/${repository}/releases/tag/${tag}` };
  }
  private async githubRelease(target: string, repository: string): Promise<{ manifest: ReleaseManifest | null; releaseUrl: string }> {
    let response: Response;
    try { response = await this.request(target, false, undefined, true); }
    catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) throw error;
      try { return await this.latestGithubManifest(repository); }
      catch (fallback) { throw new Error('GitHub 更新 API 无法连接，官方发布通道读取失败：' + (fallback instanceof Error ? fallback.message : String(fallback))); }
    }
    if ([403, 429, 500, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      try { return await this.latestGithubManifest(repository); }
      catch (error) { throw new Error(`GitHub 更新 API 暂不可用（HTTP ${response.status}），官方发布通道读取失败：` + (error instanceof Error ? error.message : String(error))); }
    }
    if (response.status === 404) { await response.body?.cancel(); return { manifest: null, releaseUrl: `https://github.com/${repository}/releases` }; }
    if (!response.ok) { await response.body?.cancel(); throw new Error('更新检查失败（HTTP ' + response.status + '）'); }
    const value = await jsonResponse(response);
    if (value?.draft !== false || value?.prerelease !== false || typeof value.tag_name !== 'string' || typeof value.published_at !== 'string' || !Array.isArray(value.assets)) throw new Error('GitHub 发布信息无效');
    const version = value.tag_name.replace(/^v/, ''); compareVersions(version, this.version);
    const asset = value.assets.find((item: any) => item.name === 'release.json' && item.state === 'uploaded');
    if (!asset) throw new Error('正式版本缺少统一更新清单，暂不能自动更新');
    const expected = 'https://github.com/' + repository + '/releases/download/' + encodeURIComponent(value.tag_name) + '/';
    const manifestURL = httpsURL(asset.browser_download_url);
    if (!manifestURL.startsWith(expected)) throw new Error('GitHub 更新清单来源不一致');
    const manifestResponse = await this.request(manifestURL, true, undefined, true);
    if (!manifestResponse.ok) { await manifestResponse.body?.cancel(); throw new Error('GitHub 更新清单读取失败'); }
    const manifest = validateManifest(await jsonResponse(manifestResponse));
    if (manifest.version !== version) throw new Error('更新清单与 GitHub 标签版本不一致');
    for (const download of Object.values(manifest.downloads)) {
      if (!httpsURL(download.url).startsWith(expected)) throw new Error('GitHub 安装包来源不一致');
      const releaseAsset = value.assets.find((item: any) => item.state === 'uploaded' && item.browser_download_url === download.url);
      if (!releaseAsset || (releaseAsset.digest && releaseAsset.digest !== 'sha256:' + download.sha256.toLowerCase()) || (download.size !== undefined && releaseAsset.size !== download.size)) throw new Error('更新清单与 GitHub 安装包不一致');
    }
    return { manifest, releaseUrl: 'https://github.com/' + repository + '/releases/tag/' + encodeURIComponent(value.tag_name) };
  }
  async check(feed = ''): Promise<UpdateInfo> {
    if (this.busy) throw new Error('请先完成或取消更新下载');
    const ticket = ++this.checking; this.checked = null; this.prepared = null;
    const target = httpsURL(feed.trim() || DEFAULT_UPDATE_FEED), repository = githubRepository(target);
    let manifest: ReleaseManifest; let releaseUrl = target;
    if (repository) {
      const release = await this.githubRelease(target, repository);
      releaseUrl = release.releaseUrl;
      if (!release.manifest) {
        const result: UpdateInfo = { currentVersion: this.version, version: this.version, available: false, status: 'unpublished', source: 'github', notes: '仓库尚未发布正式版本。', url: '', publishedAt: '', releaseUrl };
        if (ticket !== this.checking) throw new Error('更新来源已变化，请重新检查');
        this.checked = result; return result;
      }
      manifest = release.manifest;
    } else {
      const response = await this.request(target);
      if (!response.ok) { await response.body?.cancel(); throw new Error('更新检查失败（HTTP ' + response.status + '）'); }
      manifest = validateManifest(await jsonResponse(response));
    }
    const available = compareVersions(manifest.version, this.version) > 0;
    if (manifest.databaseVersion !== undefined && (!Number.isInteger(manifest.databaseVersion) || manifest.databaseVersion < DATABASE_VERSION)) throw new Error('新版本支持的数据结构过旧，已停止更新');
    const asset = manifest.downloads?.[this.platform + '-' + this.arch];
    const common = { currentVersion: this.version, version: manifest.version, available: false, notes: manifest.notes, publishedAt: manifest.publishedAt, releaseUrl, source: repository ? 'github' as const : 'manifest' as const };
    if (!asset) {
      const result: UpdateInfo = { ...common, status: 'unsupported', url: '' };
      if (ticket !== this.checking) throw new Error('更新来源已变化，请重新检查');
      this.checked = result; return result;
    }
    if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.sha256) || (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_INSTALLER))) throw new Error('安装包校验值或大小无效');
    const url = httpsURL(asset.url), extension = this.platform === 'win32' ? '.exe' : '.zip';
    if (!new URL(url).pathname.toLowerCase().endsWith(extension)) throw new Error('安装包格式与系统不匹配');
    const result: UpdateInfo = { ...common, available, status: available ? 'available' : 'current', url, sha256: asset.sha256.toLowerCase(), size: asset.size, databaseVersion: manifest.databaseVersion };
    if (ticket !== this.checking) throw new Error('更新来源已变化，请重新检查');
    this.checked = result; return result;
  }
  async open(): Promise<void> {
    if (!this.checked?.available) throw new Error('请先检查可用的新版本');
    await this.database.enqueueWrite(() => this.database.backup('before-program-update'));
    await this.openExternal(this.checked.url);
  }
  cancel(): void { this.downloading?.abort(new DOMException('已取消下载', 'AbortError')); }
  async prepare(): Promise<PreparedUpdate> {
    if (this.busy) throw new Error('更新正在准备');
    const update = this.checked;
    if (!update?.available || !update.sha256 || !this.download) throw new Error('请先检查可用的新版本');
    const root = privateDirectory(this.download.directory);
    const extension = this.platform === 'win32' ? '.exe' : '.zip';
    const final = join(root, 'guanaitong-hub-' + update.version + '-' + randomUUID() + extension), temporary = final + '.tmp';
    const controller = new AbortController(); this.downloading = controller; this.prepared = null;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]);
    let file: Awaited<ReturnType<typeof open>> | undefined, committed = false;
    try {
      const response = await this.request(update.url, true, signal, update.source === 'github');
      if (!response.ok || !response.body) throw new Error('安装包下载失败（HTTP ' + response.status + '）');
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_INSTALLER) throw new Error('安装包过大');
      const total = update.size ?? (length > 0 ? length : null);
      const reader = response.body.getReader(), hash = createHash('sha256'); let bytes = 0, lastProgress = 0;
      file = await open(temporary, 'wx', 0o600);
      try {
        while (true) {
          signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length; if (bytes > MAX_INSTALLER || (update.size !== undefined && bytes > update.size)) throw new Error('安装包大小与清单不一致');
          hash.update(chunk.value); let written = 0;
          while (written < chunk.value.length) { const result = await file.write(chunk.value, written, chunk.value.length - written); written += result.bytesWritten; }
          if (Date.now() - lastProgress > 250) { this.download.progress?.({ phase: 'downloading', downloaded: bytes, total }); lastProgress = Date.now(); }
        }
      } finally { await reader.cancel(); }
      this.download.progress?.({ phase: 'verifying', downloaded: bytes, total });
      if (!bytes || (update.size !== undefined && bytes !== update.size) || hash.digest('hex') !== update.sha256) throw new Error('安装包校验失败，现有数据未改变');
      signal.throwIfAborted(); await file.sync(); await file.close(); file = undefined;
      await rename(temporary, final); committed = true;
      this.download.progress?.({ phase: 'backing-up', downloaded: bytes, total });
      const backupPath = await this.database.enqueueWrite(() => { signal.throwIfAborted(); return this.database.backup('before-program-update'); });
      const result: PreparedUpdate = { version: update.version, filePath: final, sha256: update.sha256, size: bytes, backupPath };
      this.prepared = result; this.download.progress?.({ phase: 'ready', downloaded: bytes, total }); return result;
    } catch (error) {
      if (file) await file.close(); await unlink(committed ? final : temporary).catch(() => {}); throw error;
    } finally { this.downloading = null; }
  }
  async install(): Promise<void> {
    if (this.busy || !this.prepared || !this.download) throw new Error('请先下载并校验安装包');
    this.installing = true;
    try {
      const prepared = this.prepared, root = await realpath(this.download.directory), file = await realpath(prepared.filePath), path = relative(root, file);
      const stat = await lstat(prepared.filePath);
      if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep) || stat.isSymbolicLink() || !stat.isFile() || stat.size !== prepared.size) throw new Error('安装包文件已变化，请重新下载');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (hash.digest('hex') !== prepared.sha256) throw new Error('安装包文件已变化，请重新下载');
      await this.database.enqueueWrite(() => this.database.backup('before-install-update'));
      if (await this.download.openPath(file)) throw new Error('安装程序未能启动，请稍后重试');
    } finally { this.installing = false; }
  }
}
