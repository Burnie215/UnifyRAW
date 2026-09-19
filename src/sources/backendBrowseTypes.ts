export interface BackendBrowseFile {
  path: string;
  name: string;
  isDir?: boolean;
  mimeType?: string;
  size?: number;
  modified?: string;
  mtime?: number;
}

export interface BackendBrowseResponse {
  files?: BackendBrowseFile[];
  hasMore?: boolean;
  total?: number;
}
