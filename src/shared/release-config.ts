export const RELEASE_REPOSITORY = 'kumamon-xu/guanaitong-hub';
export const DEFAULT_UPDATE_FEED = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${RELEASE_REPOSITORY}/releases`;
export interface ReleaseDownload { url: string; sha256: string; size?: number; }
export interface ReleaseManifest {
  format: 'guanaitong-release'; schemaVersion: 1; version: string; publishedAt: string;
  notes: string; databaseVersion?: number; signed?: boolean;
  downloads: Record<string, ReleaseDownload>;
}
