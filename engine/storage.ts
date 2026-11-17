const PREFIX = 'archive-native-';
const OWN_DIRECTORY = /^archive-native-[0-9a-f-]{36}$/;
export type StorageLease = { name: string; release: () => void };

export async function acquireStorageLease(): Promise<StorageLease> {
  const name = PREFIX + crypto.randomUUID();
  if (!navigator.locks) return { name, release: () => {} };
  let release = () => {};
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request('archive-storage:' + name, async () => {
      await new Promise<void>(done => { release = done; resolve(); });
    }).catch(reject);
  });
  return { name, release };
}

// A held Web Lock protects live results in other tabs. Without Web Locks,
// automatic cleanup is skipped rather than guessing whether another tab is active.
export async function cleanAbandonedStorage(): Promise<void> {
  if (!navigator.locks || !navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  for await (const [name] of (root as any).entries()) {
    if (!OWN_DIRECTORY.test(name)) continue;
    await navigator.locks.request('archive-storage:' + name, { ifAvailable: true }, async lock => {
      if (lock) await root.removeEntry(name, { recursive: true }).catch(() => {});
    });
  }
}

export async function removeStorage(lease: StorageLease): Promise<boolean> {
  try {
    if (typeof navigator.storage?.getDirectory !== 'function') return true;
    const root = await navigator.storage.getDirectory();
    // Terminating a worker releases its sync access handle asynchronously.
    // Keep this directory's ownership lock until removal actually completes.
    const deadline = performance.now() + 30_000;
    let delay = 50;
    while (true) {
      try { await root.removeEntry(lease.name, { recursive: true }); return true; }
      catch (error) {
        if ((error as Error).name === 'NotFoundError') return true;
        if (performance.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(1000, delay * 2);
      }
    }
  } catch { return false; } finally { lease.release(); }
}
