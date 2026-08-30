import { Injectable } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Thin wrapper over the Tauri event bus (`emit` from Rust → `listen` here). Used by the scan
 * store for the progressive multi-region scan events (`scan://started` / `scan://region` /
 * `scan://done`, ADR 0004). `on()` returns an unlisten function the caller must call.
 */
@Injectable({ providedIn: 'root' })
export class TauriEventsService {
  /** Subscribe to a backend event. Returns a promise for the unlisten fn. No-op outside Tauri. */
  on<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (!isTauri()) return Promise.resolve(() => {});
    return listen<T>(event, (e) => handler(e.payload));
  }
}
