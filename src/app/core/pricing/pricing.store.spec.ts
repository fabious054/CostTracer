import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TauriEventsService } from '../events/tauri-events.service';
import { TauriIpcService } from '../ipc/tauri-ipc.service';
import { PricingStore } from './pricing.store';

class FakeEvents {
  private readonly handlers = new Map<string, (p: unknown) => void>();
  on(event: string, handler: (p: unknown) => void): Promise<() => void> {
    this.handlers.set(event, handler);
    return Promise.resolve(() => this.handlers.delete(event));
  }
  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.(payload);
  }
}

class FakeIpc {
  readonly calls: string[] = [];
  startReturns: unknown = undefined;
  async call(command: string): Promise<unknown> {
    this.calls.push(command);
    return command === 'pricing_refresh_start' ? this.startReturns : undefined;
  }
}

function make(): { store: PricingStore; events: FakeEvents; ipc: FakeIpc } {
  const events = new FakeEvents();
  const ipc = new FakeIpc();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: TauriEventsService, useValue: events },
      { provide: TauriIpcService, useValue: ipc },
    ],
  });
  return { store: TestBed.inject(PricingStore), events, ipc };
}

describe('PricingStore', () => {
  it('reflects the refresher via pricing:// events', () => {
    const { store, events } = make();
    expect(store.refreshing()).toBeFalse();

    events.emit('pricing://refreshing', { pending: 12 });
    expect(store.refreshing()).toBeTrue();

    events.emit('pricing://idle');
    expect(store.refreshing()).toBeFalse();
  });

  it('start() kicks the core command (idempotent-safe to call repeatedly)', () => {
    const { store, ipc } = make();
    store.start();
    store.start();
    expect(ipc.calls).toEqual(['pricing_refresh_start', 'pricing_refresh_start']);
  });
});
