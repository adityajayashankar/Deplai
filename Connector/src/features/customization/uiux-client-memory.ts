import type { UiuxRun } from './uiux-workspace-types';

export type UiuxClientMemory = { key: string; prompt: string; selected: string; latestRunId: string | null; history: UiuxRun[]; updatedAt: number };
type MemoryUpdate = { prompt: string; selected: string; run: UiuxRun | null };
const databaseName = 'deplai-uiux-workspaces';
const storeName = 'workspaces';
const keyFor = (userId: string, projectId: string) => JSON.stringify([userId, projectId]);
function openMemory(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable. Drafts and history will not survive closing this page.')); return; }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'key' });
    request.onerror = () => reject(request.error || new Error('Unable to open browser memory.'));
    request.onblocked = () => reject(new Error('Browser memory is blocked by another tab. Close older UI/UX tabs and retry.'));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}
export async function readUiuxMemory(userId: string, projectId: string): Promise<UiuxClientMemory | null> {
  if (!userId || !projectId) throw new Error('An authenticated workspace is required for browser memory.');
  const db = await openMemory();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).get(keyFor(userId, projectId));
    transaction.oncomplete = () => { db.close(); resolve(request.result || null); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Unable to read browser memory.')); };
  });
}
export async function saveUiuxMemory(userId: string, projectId: string, update: MemoryUpdate): Promise<UiuxRun[]> {
  if (!userId || !projectId) throw new Error('An authenticated workspace is required for browser memory.');
  const db = await openMemory();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const key = keyFor(userId, projectId);
    let history: UiuxRun[] = [];
    const request = store.get(key);
    request.onsuccess = () => {
      const old = request.result as UiuxClientMemory | undefined;
      history = old?.history || [];
      if (update.run) history = [update.run, ...history.filter(item => item.run_id !== update.run!.run_id)];
      store.put({ key, prompt: update.prompt, selected: update.selected, latestRunId: update.run?.run_id || null, history, updatedAt: Date.now() } satisfies UiuxClientMemory);
    };
    transaction.oncomplete = () => { db.close(); resolve(history); };
    transaction.onabort = () => {
      db.close();
      reject(new Error(transaction.error?.name === 'QuotaExceededError'
        ? 'Browser storage is full. Your latest draft and progress could not be saved. Download any patches you need, then clear browser memory for this workspace.'
        : 'Browser memory could not be saved. This page still works, but recent changes may not survive closing it.'));
    };
  });
}
export async function clearUiuxMemory(userId: string, projectId: string): Promise<void> {
  const db = await openMemory();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(keyFor(userId, projectId));
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Could not clear browser memory.')); };
  });
}
