/**
 * Files and folders that operating systems, file managers, NAS boxes and sync
 * clients leave beside a user's own files. "Skip useless files" leaves them out
 * of a new archive. A folder rule also covers everything inside that folder.
 */
export interface SkipRule { what: string; os: string; folder?: boolean; test: (name: string) => boolean }
const exact = (...names: string[]) => { const set = new Set(names); return (name: string) => set.has(name); };
const anyCase = (...names: string[]) => { const set = new Set(names.map(name => name.toLowerCase())); return (name: string) => set.has(name.toLowerCase()); };
export const skipInventory: readonly SkipRule[] = [
 { os: 'macOS', what: 'Finder view settings', test: exact('.DS_Store') },
 { os: 'macOS', what: 'Resource fork copy', test: name => name.startsWith('._') && name.length > 2 },
 { os: 'macOS', what: 'Resource forks from Archive Utility', folder: true, test: exact('__MACOSX') },
 { os: 'macOS', what: 'Spotlight index', folder: true, test: exact('.Spotlight-V100') },
 { os: 'macOS', what: 'Trash', folder: true, test: exact('.Trashes') },
 { os: 'macOS', what: 'File system event log', folder: true, test: exact('.fseventsd') },
 { os: 'macOS', what: 'Temporary items', folder: true, test: exact('.TemporaryItems') },
 { os: 'macOS', what: 'Version history store', folder: true, test: exact('.DocumentRevisions-V100') },
 { os: 'macOS', what: 'Netatalk metadata', folder: true, test: exact('.AppleDouble', '.AppleDB', '.AppleDesktop') },
 { os: 'macOS', what: 'Volume settings', test: exact('.VolumeIcon.icns', '.apdisk', '.com.apple.timemachine.donotpresent', '.metadata_never_index', '.localized') },
 { os: 'macOS', what: 'Custom folder icon', test: exact('Icon\r') },
 { os: 'Windows', what: 'Thumbnail cache', test: anyCase('Thumbs.db', 'Thumbs.db:encryptable', 'ehthumbs.db', 'ehthumbs_vista.db') },
 { os: 'Windows', what: 'Folder view settings', test: anyCase('desktop.ini') },
 { os: 'Windows', what: 'Recycle Bin', folder: true, test: anyCase('$RECYCLE.BIN', 'RECYCLER') },
 { os: 'Windows', what: 'System restore data', folder: true, test: anyCase('System Volume Information') },
 { os: 'Windows', what: 'Office lock file', test: name => name.startsWith('~$') && name.length > 2 },
 { os: 'Linux', what: 'Folder view settings', test: exact('.directory') },
 { os: 'Linux', what: 'Trash', folder: true, test: name => /^\.Trash(-\d+)?$/.test(name) },
 { os: 'Linux', what: 'Open-file placeholder', test: name => /^\.(fuse_hidden[0-9a-f]+|nfs[0-9a-f]{8,})/i.test(name) },
 { os: 'LibreOffice', what: 'Lock file', test: name => /^\.~lock\..+#$/.test(name) },
 { os: 'NAS', what: 'Synology index', folder: true, test: exact('@eaDir') },
 { os: 'NAS', what: 'Synology recycle bin', folder: true, test: exact('#recycle') },
 { os: 'NAS', what: 'QNAP thumbnails', folder: true, test: exact('.@__thumb') },
 { os: 'Dropbox', what: 'Sync metadata', test: exact('.dropbox', '.dropbox.attr') },
 { os: 'Dropbox', what: 'Sync cache', folder: true, test: exact('.dropbox.cache') },
 { os: 'iCloud', what: 'Download placeholder', test: name => /^\..+\.icloud$/.test(name) },
];
/** The rule that makes `path` useless, if any. `isDirectory` marks an entry that is itself a folder. */
export function uselessFile(path: string, isDirectory = false): SkipRule | undefined {
 const parts = path.split('/').filter(Boolean);
 for (let index = 0; index < parts.length; index++) {
  const last = index === parts.length - 1, folder = !last || isDirectory;
  const rule = skipInventory.find(rule => (folder || !rule.folder) && rule.test(parts[index]));
  if (rule) return rule;
 }
 return undefined;
}
