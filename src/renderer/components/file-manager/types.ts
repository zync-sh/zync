export interface FileEntry {
  name: string;
  type: '-' | 'd' | 'l'; // file, directory, link
  size: number;
  modifyTime: number;
  accessTime: number;
  rights: {
    user: string;
    group: string;
    other: string;
  };
  owner: number;
  group: number;
}
