/**
 * Files and folders a new archive can leave out, in three kinds:
 * - `garbage`: what operating systems, file managers, NAS boxes and sync clients leave beside a user's own files;
 * - `vcs`: version-control metadata (git, Mercurial, Subversion, CVS and others);
 * - `regenerable`: build output, dependency folders and caches that a project's own tools recreate.
 * A folder rule also covers everything inside that folder.
 */
export type SkipKind = 'garbage' | 'vcs' | 'regenerable';
export const skipKinds: readonly SkipKind[] = ['garbage', 'vcs', 'regenerable'];
/** `test` sees one path segment; `next` is the segment after it, for rules that need the folder below (bin/Debug). */
export interface SkipRule { kind: SkipKind; what: string; from: string; folder?: boolean; test: (name: string, next?: string) => boolean }
const exact = (...names: string[]) => { const set = new Set(names); return (name: string) => set.has(name); };
const anyCase = (...names: string[]) => { const set = new Set(names.map(name => name.toLowerCase())); return (name: string) => set.has(name.toLowerCase()); };
const suffix = (...endings: string[]) => (name: string) => endings.some(ending => name.length > ending.length && name.endsWith(ending));
type Entry = Omit<SkipRule, 'kind'>;
const kind = (kind: SkipKind, entries: Entry[]): SkipRule[] => entries.map(entry => ({ kind, ...entry }));

const garbage = kind('garbage', [
 { from: 'macOS', what: 'Finder view settings', test: exact('.DS_Store') },
 { from: 'macOS', what: 'Resource fork copy', test: name => name.startsWith('._') && name.length > 2 },
 { from: 'macOS', what: 'Resource forks from Archive Utility', folder: true, test: exact('__MACOSX') },
 { from: 'macOS', what: 'Spotlight index', folder: true, test: exact('.Spotlight-V100') },
 { from: 'macOS', what: 'Trash', folder: true, test: exact('.Trashes') },
 { from: 'macOS', what: 'File system event log', folder: true, test: exact('.fseventsd') },
 { from: 'macOS', what: 'Temporary items', folder: true, test: exact('.TemporaryItems') },
 { from: 'macOS', what: 'Version history store', folder: true, test: exact('.DocumentRevisions-V100') },
 { from: 'macOS', what: 'Netatalk metadata', folder: true, test: exact('.AppleDouble', '.AppleDB', '.AppleDesktop') },
 { from: 'macOS', what: 'Volume settings', test: exact('.VolumeIcon.icns', '.apdisk', '.com.apple.timemachine.donotpresent', '.metadata_never_index', '.localized') },
 { from: 'macOS', what: 'Custom folder icon', test: exact('Icon\r') },
 { from: 'Windows', what: 'Thumbnail cache', test: anyCase('Thumbs.db', 'Thumbs.db:encryptable', 'ehthumbs.db', 'ehthumbs_vista.db') },
 { from: 'Windows', what: 'Folder view settings', test: anyCase('desktop.ini') },
 { from: 'Windows', what: 'Recycle Bin', folder: true, test: anyCase('$RECYCLE.BIN', 'RECYCLER') },
 { from: 'Windows', what: 'System restore data', folder: true, test: anyCase('System Volume Information') },
 { from: 'Windows', what: 'Office lock file', test: name => name.startsWith('~$') && name.length > 2 },
 { from: 'Linux', what: 'Folder view settings', test: exact('.directory') },
 { from: 'Linux', what: 'Trash', folder: true, test: name => /^\.Trash(-\d+)?$/.test(name) },
 { from: 'Linux', what: 'Open-file placeholder', test: name => /^\.(fuse_hidden[0-9a-f]+|nfs[0-9a-f]{8,})/i.test(name) },
 { from: 'LibreOffice', what: 'Lock file', test: name => /^\.~lock\..+#$/.test(name) },
 { from: 'NAS', what: 'Synology index', folder: true, test: exact('@eaDir') },
 { from: 'NAS', what: 'Synology recycle bin', folder: true, test: exact('#recycle') },
 { from: 'NAS', what: 'QNAP thumbnails', folder: true, test: exact('.@__thumb') },
 { from: 'Dropbox', what: 'Sync metadata', test: exact('.dropbox', '.dropbox.attr') },
 { from: 'Dropbox', what: 'Sync cache', folder: true, test: exact('.dropbox.cache') },
 { from: 'iCloud', what: 'Download placeholder', test: name => /^\..+\.icloud$/.test(name) },
]);

const vcs = kind('vcs', [
 { from: 'Git', what: 'Git repository', folder: true, test: exact('.git') },
 { from: 'Git', what: 'Git worktree or submodule link', test: exact('.git') },
 { from: 'Git', what: 'Git settings', test: exact('.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.git-blame-ignore-revs', '.mailmap') },
 { from: 'Mercurial', what: 'Mercurial repository', folder: true, test: exact('.hg') },
 { from: 'Mercurial', what: 'Mercurial settings', test: exact('.hgignore', '.hgtags', '.hgsub', '.hgsubstate', '.hg_archival.txt') },
 { from: 'Subversion', what: 'Subversion working copy', folder: true, test: exact('.svn', '_svn') },
 { from: 'CVS', what: 'CVS working copy', folder: true, test: exact('CVS') },
 { from: 'CVS', what: 'CVS settings', test: exact('.cvsignore') },
 { from: 'Bazaar', what: 'Bazaar branch', folder: true, test: exact('.bzr') },
 { from: 'Bazaar', what: 'Bazaar settings', test: exact('.bzrignore') },
 { from: 'Darcs', what: 'Darcs repository', folder: true, test: exact('_darcs') },
 { from: 'Fossil', what: 'Fossil checkout', test: exact('.fslckout', '_FOSSIL_') },
 { from: 'Fossil', what: 'Fossil settings', folder: true, test: exact('.fossil-settings') },
 { from: 'Pijul', what: 'Pijul repository', folder: true, test: exact('.pijul') },
 { from: 'Jujutsu', what: 'Jujutsu repository', folder: true, test: exact('.jj') },
 { from: 'Sapling', what: 'Sapling repository', folder: true, test: exact('.sl') },
 { from: 'Monotone', what: 'Monotone workspace', folder: true, test: exact('_MTN') },
 { from: 'GNU Arch', what: 'Arch metadata', folder: true, test: exact('{arch}', '.arch-ids') },
 { from: 'RCS', what: 'RCS history', folder: true, test: exact('RCS') },
 { from: 'SCCS', what: 'SCCS history', folder: true, test: exact('SCCS') },
 { from: 'Perforce', what: 'Perforce settings', test: exact('.p4config', '.p4ignore', '.p4ignore.txt') },
 { from: 'Plastic SCM', what: 'Plastic workspace', folder: true, test: exact('.plastic') },
 { from: 'Team Foundation', what: 'TFVC workspace', folder: true, test: anyCase('$tf') },
 { from: 'Repo', what: 'Repo tool checkout', folder: true, test: exact('.repo') },
]);

// Build output, dependencies and caches for 25+ languages. Names that often hold a user's own files
// (bin on its own, lib, env, local, packages) are left out.
const regenerable = kind('regenerable', [
 // JavaScript and TypeScript
 { from: 'JavaScript', what: 'npm, Yarn or pnpm packages', folder: true, test: exact('node_modules') },
 { from: 'JavaScript', what: 'Bower or jspm packages', folder: true, test: exact('bower_components', 'jspm_packages') },
 { from: 'JavaScript', what: 'Framework build output', folder: true, test: exact('.next', '.nuxt', '.svelte-kit', '.angular', '.docusaurus', '.expo', '.output', 'storybook-static') },
 { from: 'JavaScript', what: 'Bundler cache', folder: true, test: exact('.parcel-cache', '.turbo', '.vite', '.webpack', '.esbuild', '.rollup.cache') },
 { from: 'JavaScript', what: 'Test coverage output', folder: true, test: exact('coverage', '.nyc_output') },
 { from: 'JavaScript', what: 'Lint or type-check cache', test: name => name === '.eslintcache' || name === '.stylelintcache' || suffix('.tsbuildinfo')(name) },
 { from: 'JavaScript', what: 'Package manager log', test: name => /^(npm-debug|yarn-error|yarn-debug|pnpm-debug|lerna-debug)\.log/.test(name) },
 // Python
 { from: 'Python', what: 'Bytecode cache', folder: true, test: exact('__pycache__') },
 { from: 'Python', what: 'Compiled bytecode', test: suffix('.pyc', '.pyo') },
 { from: 'Python', what: 'Virtual environment', folder: true, test: exact('.venv', 'venv', '.virtualenv') },
 { from: 'Python', what: 'Test and type-check cache', folder: true, test: exact('.tox', '.nox', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis', '.pyre', '.pytype', '.pdm-build') },
 { from: 'Python', what: 'Package build metadata', folder: true, test: name => name === '.eggs' || name === '__pypackages__' || suffix('.egg-info')(name) },
 { from: 'Python', what: 'Coverage data', test: exact('.coverage') },
 { from: 'Python', what: 'Coverage report', folder: true, test: exact('htmlcov') },
 { from: 'Jupyter', what: 'Notebook checkpoints', folder: true, test: exact('.ipynb_checkpoints') },
 // JVM: Java, Kotlin, Scala, Groovy, Clojure
 { from: 'Java', what: 'Maven, sbt, Cargo or Leiningen output', folder: true, test: exact('target') },
 { from: 'Java', what: 'Gradle cache', folder: true, test: exact('.gradle', '.kotlin') },
 { from: 'Java', what: 'Compiled class', test: suffix('.class') },
 { from: 'Scala', what: 'Build server state', folder: true, test: exact('.bloop', '.metals', '.bsp') },
 { from: 'Clojure', what: 'Classpath cache', folder: true, test: exact('.cpcache', '.shadow-cljs', '.lsp') },
 // .NET: C#, F#, Visual Basic
 { from: '.NET', what: 'Intermediate build output', folder: true, test: exact('obj') },
 { from: '.NET', what: 'Debug or Release build', folder: true, test: (name, next) => name === 'bin' && !!next && /^(Debug|Release|x64|x86|ARM64)$/i.test(next) },
 { from: '.NET', what: 'Visual Studio cache', folder: true, test: exact('.vs') },
 { from: 'F#', what: 'FAKE or Paket cache', folder: true, test: exact('.fake', 'paket-files', '.ionide') },
 // C and C++
 { from: 'C/C++', what: 'CMake build tree', folder: true, test: name => name === 'CMakeFiles' || name.startsWith('cmake-build-') },
 { from: 'C/C++', what: 'Object file', test: suffix('.o', '.lo') },
 { from: 'C/C++', what: 'Language server cache', folder: true, test: exact('.ccls-cache', '.clangd') },
 // Go, Zig, Nim (Rust's target is covered above)
 { from: 'Go', what: 'Vendored modules', folder: true, test: exact('vendor') },
 { from: 'Zig', what: 'Zig build cache and output', folder: true, test: exact('zig-cache', '.zig-cache', 'zig-out') },
 { from: 'Nim', what: 'Nim build cache', folder: true, test: exact('nimcache', 'nimblecache') },
 // Ruby, PHP, Perl, Lua
 { from: 'Ruby', what: 'Bundler settings and gems', folder: true, test: exact('.bundle') },
 { from: 'PHP', what: 'Tool cache', test: exact('.phpunit.result.cache', '.php-cs-fixer.cache', '.php_cs.cache') },
 { from: 'Perl', what: 'Module build output', folder: true, test: exact('blib', '_build') },
 { from: 'Lua', what: 'LuaRocks packages', folder: true, test: exact('lua_modules', '.luarocks') },
 // Apple: Swift and Objective-C
 { from: 'Swift', what: 'Swift Package Manager build', folder: true, test: exact('.build') },
 { from: 'Xcode', what: 'Derived data', folder: true, test: exact('DerivedData') },
 { from: 'Xcode', what: 'Per-user project state', folder: true, test: exact('xcuserdata') },
 { from: 'Objective-C', what: 'CocoaPods or Carthage dependencies', folder: true, test: exact('Pods', 'Carthage') },
 // Dart, Flutter, Elixir, Erlang, Haskell, OCaml, Elm, R
 { from: 'Dart', what: 'Dart tool state', folder: true, test: exact('.dart_tool', '.pub-cache', '.pub') },
 { from: 'Flutter', what: 'Plugin registry', test: exact('.flutter-plugins', '.flutter-plugins-dependencies') },
 { from: 'Elixir', what: 'Mix dependencies and language server', folder: true, test: exact('deps', '.elixir_ls') },
 { from: 'Erlang', what: 'Compiled BEAM file', test: suffix('.beam') },
 { from: 'Erlang', what: 'Rebar3 cache', folder: true, test: exact('.rebar3') },
 { from: 'Haskell', what: 'Stack or Cabal build', folder: true, test: exact('.stack-work', 'dist-newstyle') },
 { from: 'Haskell', what: 'Interface file', test: suffix('.hi', '.dyn_hi', '.dyn_o') },
 { from: 'OCaml', what: 'opam or esy switch', folder: true, test: exact('_opam', '_esy') },
 { from: 'Elm', what: 'Elm package cache', folder: true, test: exact('elm-stuff') },
 { from: 'R', what: 'RStudio state', folder: true, test: exact('.Rproj.user') },
 { from: 'R', what: 'Session history', test: exact('.Rhistory') },
 // Shared by many toolchains
 { from: 'Build tools', what: 'Build output', folder: true, test: exact('build', 'dist', 'out') },
 { from: 'Build tools', what: 'Tool cache', folder: true, test: exact('.cache', '.sass-cache') },
 { from: 'Terraform', what: 'Provider plugins', folder: true, test: exact('.terraform') },
 { from: 'Emacs', what: 'Compiled Lisp', test: suffix('.elc') },
]);

export const skipInventory: readonly SkipRule[] = [...garbage, ...vcs, ...regenerable];
export const garbageOnly: ReadonlySet<SkipKind> = new Set<SkipKind>(['garbage']);

/** The rule that leaves `path` out under `kinds`, if any. `isDirectory` marks an entry that is itself a folder. */
export function skipRule(path: string, isDirectory = false, kinds: ReadonlySet<SkipKind> = garbageOnly): SkipRule | undefined {
 if (!kinds.size) return undefined;
 const parts = path.split('/').filter(Boolean);
 for (let index = 0; index < parts.length; index++) {
  const folder = index < parts.length - 1 || isDirectory;
  const rule = skipInventory.find(rule => kinds.has(rule.kind) && (folder || !rule.folder) && rule.test(parts[index], parts[index + 1]));
  if (rule) return rule;
 }
 return undefined;
}
/** Garbage only: system and sync-client leftovers. */
export const uselessFile = (path: string, isDirectory = false) => skipRule(path, isDirectory, garbageOnly);
