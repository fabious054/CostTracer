import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { IpcCommand, IpcCommandMap } from '../models/ipc-contracts';

type ArgsOf<K extends IpcCommand> = IpcCommandMap[K]['args'];
type ResultOf<K extends IpcCommand> = IpcCommandMap[K]['result'];

/**
 * The single doorway between the webview and the Rust core. Nothing else in the app calls
 * `invoke` directly — this keeps the command surface typed (`IpcCommandMap`) and gives tests
 * one seam to fake.
 */
@Injectable({ providedIn: 'root' })
export class TauriIpcService {
  call<K extends IpcCommand>(
    command: K,
    ...rest: ArgsOf<K> extends undefined ? [] : [ArgsOf<K>]
  ): Promise<ResultOf<K>> {
    if (!isTauri()) {
      return Promise.reject(
        new Error('The CostTracer core is unavailable — run this UI inside the desktop app, not a browser.'),
      );
    }
    const args = rest[0] as Record<string, unknown> | undefined;
    return invoke<ResultOf<K>>(command, args);
  }
}
