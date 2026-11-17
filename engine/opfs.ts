// Directory metadata stays in JavaScript; file contents use one random-access
// OPFS backing store. Dynamic repair scratch files never enter the WASM heap.
const PAGE_SIZE = 512 * 1024;
const ZERO_PAGE = new Uint8Array(PAGE_SIZE);
type DiskFile = { size: number; pages: Map<number, number>; inode: number; links: number; opens: number };
export class DiskVolume {
  private nextPage = PAGE_SIZE;
  private freePages: number[] = [];
  private closed = false;
  private readonly files = new WeakMap<object, DiskFile>();
  private constructor(private module: any, private file: FileSystemFileHandle, private access: any, readonly quota: number) {
    if (quota < PAGE_SIZE) throw new Error('Insufficient browser disk quota');
    this.access.truncate(PAGE_SIZE);
  }

  static async create(module: any, name: string): Promise<DiskVolume> {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(name, { create: true });
    const file = await directory.getFileHandle('contents.bin', { create: true });
    const access = await (file as any).createSyncAccessHandle();
    try {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, estimate.quota - (estimate.usage || 0));
      return new DiskVolume(module, file, access, quota);
    } catch (error) { access.close(); throw error; }
  }

  mount(path: string): void {
    const fs = this.module.FS;
    const rename = fs.rename.bind(fs);
    fs.rename = (source: string, destination: string) => {
      const from = fs.lookupPath(source, { follow: false }).node;
      let to: any;
      try { to = fs.lookupPath(destination, { follow: false }).node; } catch {}
      if (this.files.has(from) && this.files.get(from) === this.files.get(to)) return;
      return rename(source, destination);
    };
    const memory = fs.lookupPath('/').node.mount.type;
    const decorate = (node: any, existing?: DiskFile): any => {
      const base = node.node_ops;
      if (fs.isDir(node.mode)) {
        node.contents = Object.assign(Object.create(null), node.contents);
        node.node_ops = {
          ...base,
          mknod: (parent: any, name: string, mode: number, dev: number) => decorate(base.mknod(parent, name, mode, dev)),
          link: (parent: any, name: string, oldpath: string, flags: number) => {
            const source = fs.lookupPath(oldpath, { follow: !!(flags & 1024) }).node;
            const disk = this.files.get(source);
            if (!disk) throw new fs.ErrnoError(75);
            const linked = decorate(base.mknod(parent, name, source.mode, 0), disk);
            disk.links++;
            return linked;
          },
          unlink: (parent: any, name: string) => {
            const disk = this.files.get(fs.lookupNode(parent, name));
            base.unlink(parent, name);
            if (disk) { disk.links--; this.releaseUnlinked(disk); }
          },
          rename: (node: any, parent: any, name: string) => {
            const replaced = parent.contents?.[name];
            const disk = replaced && replaced !== node ? this.files.get(replaced) : undefined;
            base.rename(node, parent, name);
            if (disk) { disk.links--; this.releaseUnlinked(disk); }
          },
        };
      } else if (fs.isFile(node.mode)) {
        const disk: DiskFile = existing ?? { size: 0, pages: new Map(), inode: node.id, links: 1, opens: 0 };
        this.files.set(node, disk);
        node.node_ops = {
          ...base,
          getattr: (n: any) => ({ ...base.getattr(n), size: disk.size, ino: disk.inode, nlink: disk.links, blocks: Math.ceil(disk.size / 512) }),
          setattr: (n: any, attrs: any) => {
            if (attrs.size !== undefined) this.resize(disk, attrs.size);
            const metadata = { ...attrs }; delete metadata.size;
            base.setattr(n, metadata);
          },
        };
        node.stream_ops = {
          ...node.stream_ops,
          open: () => { disk.opens++; },
          close: () => { disk.opens--; this.releaseUnlinked(disk); },
          read: (_stream: any, buffer: Uint8Array, offset: number, length: number, position: number) => this.read(disk, buffer, offset, length, position),
          write: (_stream: any, buffer: Uint8Array, offset: number, length: number, position: number) => this.write(disk, buffer, offset, length, position),
          llseek: (stream: any, offset: number, whence: number) => {
            const position = whence === 1 ? stream.position + offset : whence === 2 ? disk.size + offset : offset;
            if (!Number.isSafeInteger(position) || position < 0) throw new fs.ErrnoError(28);
            return position;
          },
          allocate: (_stream: any, offset: number, length: number) => this.resize(disk, Math.max(disk.size, offset + length)),
          mmap: () => { throw new fs.ErrnoError(43); },
          msync: () => { this.access.flush(); return 0; },
        };
      }
      return node;
    };
    fs.mount({ mount: (mount: any) => decorate(memory.mount(mount)) }, {}, path);
  }

  private releaseUnlinked(file: DiskFile): void {
    if (file.links || file.opens) return;
    for (const page of file.pages.values()) this.freePages.push(page);
    file.pages.clear(); file.size = 0;
  }

  private resize(file: DiskFile, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid disk file size');
    if (size < file.size) {
      for (const [page, offset] of file.pages) if (page * PAGE_SIZE >= size) { file.pages.delete(page); this.freePages.push(offset); }
      const tail = size % PAGE_SIZE, page = file.pages.get(Math.floor(size / PAGE_SIZE));
      if (tail && page !== undefined) this.writeExact(ZERO_PAGE.subarray(tail), page + tail);
    }
    file.size = size;
  }

  private read(file: DiskFile, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const count = Math.max(0, Math.min(length, file.size - position));
    let done = 0;
    while (done < count) {
      const pageIndex = Math.floor((position + done) / PAGE_SIZE), within = (position + done) % PAGE_SIZE;
      const amount = Math.min(count - done, PAGE_SIZE - within), target = buffer.subarray(offset + done, offset + done + amount);
      const page = file.pages.get(pageIndex);
      if (page === undefined) target.fill(0); else {
        const read = this.access.read(target, { at: page + within });
        if (read !== amount) throw new Error('Browser disk read was incomplete; output integrity cannot be guaranteed');
      }
      done += amount;
    }
    return count;
  }

  private write(file: DiskFile, buffer: Uint8Array, offset: number, length: number, position: number): number {
    if (!Number.isSafeInteger(position + length) || position < 0) throw new Error('Invalid disk write position');
    let done = 0;
    while (done < length) {
      const index = Math.floor((position + done) / PAGE_SIZE), within = (position + done) % PAGE_SIZE;
      const amount = Math.min(length - done, PAGE_SIZE - within);
      let page = file.pages.get(index);
      if (page === undefined) {
        page = this.freePages.pop();
        if (page === undefined) {
          page = this.nextPage;
          if (page + PAGE_SIZE > this.quota) throw new Error('Browser disk quota exhausted while processing files');
          // Advance allocation only after successful disk extension.
          this.access.truncate(page + PAGE_SIZE);
          this.nextPage += PAGE_SIZE;
        } else {
          try { this.writeExact(ZERO_PAGE, page); } catch (error) { this.freePages.push(page); throw error; }
        }
        file.pages.set(index, page);
      }
      const written = this.access.write(buffer.subarray(offset + done, offset + done + amount), { at: page + within });
      if (written !== amount) throw new Error('Browser disk write was incomplete; storage may be full');
      done += written;
    }
    file.size = Math.max(file.size, position + done);
    return done;
  }

  private writeExact(bytes: Uint8Array, position: number): void {
    if (this.access.write(bytes, { at: position }) !== bytes.length) throw new Error('Browser disk write was incomplete; storage may be full');
  }

  async outputs(rootPath: string, publishFiles?:ReadonlySet<string>): Promise<{ name: string; blob: Blob }[]> {
    const fs = this.module.FS;
    const entries: { name: string; disk: DiskFile }[] = [];
    const walk = (path: string, prefix: string) => {
      for (const name of fs.readdir(path)) {
        if (name === '.' || name === '..' || (path === rootPath && name === '.work')) continue;
        const child = path + '/' + name, node = fs.lookupPath(child).node;
        if (fs.isDir(node.mode)) walk(child, prefix + name + '/');
        else if(!publishFiles||publishFiles.has(prefix+name)) { const disk = this.files.get(node); if (disk) entries.push({ name: prefix + name, disk }); }
      }
    };
    walk(rootPath, '');
    this.close();
    const backing = await this.file.getFile();
    return entries.map(({ name, disk }) => {
      const parts: BlobPart[] = [];
      // Coalesce adjacent physical pages; sparse holes use logarithmic Blob
      // composition, so snapshots scale with allocated pages rather than size.
      const zeroes = (size: number): Blob => {
        let unit = new Blob([ZERO_PAGE]), remaining = size;
        const zeroParts: BlobPart[] = [];
        while (remaining >= PAGE_SIZE) {
          const pages = Math.floor(remaining / PAGE_SIZE);
          let run = unit;
          while (run.size * 2 <= pages * PAGE_SIZE) run = new Blob([run, run]);
          zeroParts.push(run); remaining -= run.size;
        }
        if (remaining) zeroParts.push(ZERO_PAGE.subarray(0, remaining));
        return new Blob(zeroParts);
      };
      const pages = [...disk.pages].sort((a, b) => a[0] - b[0]);
      let position = 0;
      for (let index = 0; index < pages.length; index++) {
        const [logical, physical] = pages[index], start = logical * PAGE_SIZE;
        if (start >= disk.size) break;
        if (start > position) parts.push(zeroes(start - position));
        let end = Math.min(disk.size, start + PAGE_SIZE);
        while (index + 1 < pages.length && pages[index + 1][0] * PAGE_SIZE === end && pages[index + 1][1] === physical + end - start) {
          index++; end = Math.min(disk.size, end + PAGE_SIZE);
        }
        parts.push(backing.slice(physical, physical + end - start));
        position = end;
      }
      if (position < disk.size) parts.push(zeroes(disk.size - position));
      return { name, blob: new Blob(parts) };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.access.flush(); } finally { this.access.close(); }
  }
}
