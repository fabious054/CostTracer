# ADR 0001 — Angular state management structure (onboarding flow)

- **Status:** Accepted — 2026-08-28
- **Date:** 2026-08-28
- **Scope affected:** Scope 1 (AWS connection flow) and the foundation for Scopes 2–3
- **Related locked decision:** credential vault = `keyring` v3 crate + custom Tauri commands

## Decision

**Option A — hand-rolled signal service (`ConnectionStore`)**, under the two conditions in
section 5 (respect the store contract from section 1; concentrate transitions in an exhaustive
pure reducer with negative-path tests).

Recorded inputs from the decision-maker (answers to section 7):

1. No external contributors expected during Phases 0–1.
2. A visual statechart is *not* a first-class requirement — it can be drawn by hand later from the
   reducer, without the library running.
3. No explicit bundle ceiling, but the choice must stay aligned with the local-first pitch.
4. No appetite to add the frontend's first runtime dependency yet.
5. No prior team experience with XState or NgRx.

**Revisit as ADR 0002 at the start of Scope 2**, when entity collections / sortable tables /
temporal history arrive and `@ngrx/signals`' `withEntities` may start to pay for itself. The A→B
migration is mechanical as long as the store contract is respected.

---

## 1. Context

Scope 1 is an onboarding wizard that is, in practice, a **finite state machine** with strict
transition rules. Planned states (discriminated union keyed by `step`):

```
booting · revalidating · detecting · methodSelect · manualEntry · ssoStart ·
ssoDeviceAuth · validating · validationFailed · checkingPermissions ·
excessivePermissions · persisting · connected
```

Requirements that pressure the choice:

1. **Transition correctness.** Explicit rules from the acceptance criteria, e.g. an invalid
   credential keeps the user in `validationFailed` — it does **not** fall back to `methodSelect`
   "from scratch". An illegal transition here is a product bug.
2. **Async orchestration with cancellation.** SSO token polling (`ssoDeviceAuth`), silent
   revalidation on boot, "try again". The user can cancel mid-flight; pending requests must be
   discarded without corrupting the state.
3. **Boundary with Rust.** Every AWS call and every vault access lives in the Rust core. The Angular
   store only dispatches `invoke()` and reduces the response DTO into a new state. No secret ever
   passes through the store.
4. **Local-first ethos.** Minimize the webview bundle and the dependency surface. This would be the
   **first runtime dependency** of the frontend (outside Angular itself).
5. **Growth.** Scope 2 brings entity collections (idle resources, tables, temporal history); Scope 3
   brings multi-account. The choice must not be a dead end.
6. **Maintenance.** Today it is a solo developer. External contributors during Phases 0–1 are
   possible but not guaranteed — convention familiarity has value, but is not decisive yet.

**Technical baseline:** Angular 20, standalone components, native signals, new control flow
(`@switch`/`@if`). The wizard host does `@switch (store.step())` and renders one component per state.

**Contract required of any option** (to keep components decoupled from the implementation):

```ts
interface ConnectionStoreContract {
  readonly state: Signal<ConnectionState>;   // discriminated union, read-only
  readonly step:  Signal<ConnectionState['step']>;
  // intent methods (one per user action), all async:
  boot(): Promise<void>;
  chooseDetected(): Promise<void>;
  submitManual(input: ManualCredentialInput): Promise<void>;
  startSso(input: SsoStartInput): Promise<void>;
  retryValidation(): Promise<void>;
  switchMethod(): void;
  acceptRiskAndContinue(): Promise<void>;
  disconnect(): Promise<void>;
}
```

If components only depend on this contract, the internal implementation can be swapped later without
touching the UI.

---

## 2. Decision drivers (in weight order)

| # | Driver | Why |
|---|--------|-----|
| D1 | FSM transition correctness | Hard business rule from the acceptance criteria |
| D2 | Bundle + dependency surface | Local-first ethos; first frontend runtime dependency |
| D3 | Async cancellation | SSO polling / revalidation / retry |
| D4 | Evolution path to Scope 2 (entities, tables, history) | Avoid structural rework |
| D5 | Convention familiarity for contributors | Real value, not decisive in Phase 0 |
| D6 | Testability of transitions in isolation | Security-sensitive flow |

---

## 3. Options

### Option A — Hand-rolled signal service (`ConnectionStore`)

```ts
@Injectable({ providedIn: 'root' })
export class ConnectionStore implements ConnectionStoreContract {
  private readonly _state = signal<ConnectionState>({ step: 'booting' });
  readonly state = this._state.asReadonly();
  readonly step  = computed(() => this._state().step);

  private inFlight?: AbortController;

  constructor(private ipc: TauriIpcService) {}

  async submitManual(input: ManualCredentialInput): Promise<void> {
    this._state.set({ step: 'validating', source: { kind: 'manual', ...input } });
    try {
      const res = await this.ipc.invoke('credential_validate', { input });
      this._state.set(this.reduceValidation(res));
    } catch (e) {
      this._state.set({ step: 'validationFailed', source: /* … */, kind: 'invalid', message: String(e) });
    }
  }
  // one transition = one method; cancellation = manual AbortController
}
```

- **Bundle:** ~0 kB. Nothing beyond Angular.
- **D1:** transitions by discipline — nothing stops a method from setting an illegal state.
  Mitigable with an exhaustive `switch` in the reducer + tests.
- **D3:** cancellation is manual (`AbortController` / generation flag). Works, but it is your code.
- **D4:** for Scope 2 tables/entities you rewrite collection helpers from scratch, or migrate.
- **D6:** excellent. `new ConnectionStore(fakeIpc)`, call method, assert the signal. No TestBed.
- **D5:** the convention is yours; a second dev has to learn it.
- **Future migration:** trivial **if** the contract in section 1 is respected — the class becomes a
  `signalStore(...)` without touching components.

### Option B — NgRx SignalStore (`@ngrx/signals`)

```ts
export const ConnectionStore = signalStore(
  { providedIn: 'root' },
  withState<{ current: ConnectionState }>({ current: { step: 'booting' } }),
  withComputed(({ current }) => ({ step: computed(() => current().step) })),
  withMethods((store, ipc = inject(TauriIpcService)) => ({
    submitManual: rxMethod<ManualCredentialInput>(pipe(
      tap(() => patchState(store, { current: { step: 'validating', /* … */ } })),
      switchMap(input => ipc.rx('credential_validate', { input }).pipe(
        map(res => patchState(store, { current: reduceValidation(res) })),
        catchError(() => of(patchState(store, { current: { step: 'validationFailed', /* … */ } }))),
      )),
    )),
  })),
);
```

- **Bundle:** ~5–8 kB (`@ngrx/signals`, without `@ngrx/store`).
- **D1:** same as Option A — the lib does not prevent an illegal transition, but it gives a
  recognizable structure (`withState`/`withComputed`/`withMethods`).
- **D3:** `rxMethod` + `switchMap` gives automatic cancellation of the previous request. Less of
  your own code.
- **D4:** `withEntities` / `signalStoreFeature` cover the Scope 2 collections idiomatically.
- **D6:** good. Testable without TestBed; documented patterns.
- **D5:** public convention — a contributor who knows NgRx recognizes it immediately.
- **Cost:** first frontend runtime dependency; follows the NgRx release cadence.

### Option C — Full NgRx (`@ngrx/store` + `@ngrx/effects`)

- **Bundle:** ~15–20 kB + boilerplate (actions, reducer, effects, selectors per feature).
- **D1:** pure reducers + typed actions give the most auditable and traceable transitions;
  DevTools with time-travel helps debug the sensitive flow.
- **D3:** effects isolate the async; cancellation via `switchMap` in the effects.
- **D4:** consolidated model for large apps; clean feature stores for Scopes 2–3.
- **D6:** reducers are trivially testable; effects need marble/TestScheduler.
- **Cost:** far too ceremonial for a ~13-state wizard. Tracing one transition spans 4 files. Likely
  over-engineering in Phase 0.

### Option D — XState v5 (explicit statechart) + `@xstate/angular`

```ts
const onboarding = setup({
  types: {} as { context: OnboardingContext; events: OnboardingEvent },
  actors: { validate: fromPromise(({ input }) => ipc.invoke('credential_validate', input)) },
}).createMachine({
  id: 'onboarding', initial: 'booting',
  states: {
    validationFailed: {
      on: { RETRY: 'validating', SWITCH_METHOD: 'methodSelect' }, // only these 2 exits exist
    },
    // …
  },
});
```

- **Bundle:** ~15 kB (`xstate` v5 core) + glue.
- **D1:** **illegal transitions are impossible by construction** — a state can only leave through
  the declared edges. Guards, entry/exit actions, and invoked actors with automatic cancellation
  are native.
- **D3:** invoked actors cancel themselves on state exit — fits the SSO polling directly.
- **D4:** great for the onboarding flow; for Scope 2 tables/history you will still want a data
  store alongside it (XState is not a collection layer).
- **D6:** the machine definition is the living spec; testable with `getNextState`. The statechart
  is **visualizable** — good documentation for a security-sensitive flow.
- **Cost:** a new paradigm alongside signals; learning curve if the team is unfamiliar; possibly
  heavier than the problem warrants if the machine does not grow.

---

## 4. Comparison

| Criterion | A — hand-rolled signals | B — NgRx SignalStore | C — full NgRx | D — XState |
|---|---|---|---|---|
| Extra bundle | ~0 kB | ~5–8 kB | ~15–20 kB | ~15 kB |
| New runtime deps | 0 | 1 | 2 | 1–2 |
| Prevents illegal transition | ❌ (discipline) | ❌ (discipline) | ⚠️ (traceable) | ✅ (by construction) |
| Async cancellation | manual | `rxMethod`/`switchMap` | effects/`switchMap` | actors (automatic) |
| Fit for Scope 2 (entities) | rewrite helpers | `withEntities` | feature stores | separate data store |
| Contributor familiarity | low | high | high | medium |
| Testing transitions | excellent | good | good (reducers) | excellent |
| Living documentation of the flow | no | no | partial (DevTools) | yes (statechart) |
| Ceremony | minimal | low | high | medium |

---

## 5. Recommendation

**Option A (hand-rolled signal service) for Scope 1**, under two conditions:

1. Respect the **store contract** from section 1 — components only read `state()`/`step()` and call
   intent methods. This keeps the door open to migrate the implementation later without touching the
   UI.
2. Concentrate transitions in a **reducer with an exhaustive `switch`** over `(state, event)` and
   cover it with unit transition tests (including the negative paths from the acceptance criteria).

**Rationale:** in the foundational phase, the smallest commitment wins. The FSM has ~13 states and a
handful of transitions — small enough that an exhaustive `switch` + tests cover D1 without a library.
Deferring the frontend's first runtime dependency avoids marrying the project to an external release
cadence before there is real pressure (D2). Signals are native to Angular 20 and testability is the
best of the four options (D6).

**Revisit at the start of Scope 2** (new ADR): once entity collections, sortable tables, and temporal
history arrive, `@ngrx/signals`' `withEntities` (**Option B**) likely starts to pay for itself. The
A→B migration is mechanical if the contract is respected.

**When to pick something else now:**

- If **visual, inspectable documentation of the onboarding flow** (a statechart) is a first-class
  requirement — because it is a security-sensitive flow that other people will audit — then
  **Option D (XState)** is the right bet, accepting ~15 kB and the extra paradigm.
- If you **already expect external contributors in the coming weeks**, starting with **Option B**
  saves a migration and delivers a recognizable convention from the first commit.

---

## 6. Consequences

- **If A:** define `connection.store.ts` (impl) + `connection.state.ts` (types + pure reducer) +
  `connection.store.spec.ts`. Hand-write the `AbortController`/generation token for the SSO polling.
  Create the checkpoint "ADR 0002 — Scope 2 state review".
- **If B:** add `@ngrx/signals` to `package.json`; the store becomes `signalStore(...)`; `rxMethod`
  for the async flows.
- **If C:** add `@ngrx/store` + `@ngrx/effects` + `@ngrx/store-devtools`; actions/reducer/effects/
  selectors structure per feature.
- **If D:** add `xstate` (+ `@xstate/angular`); the machine in `onboarding.machine.ts` becomes the
  source of truth and the executable spec; a simple data store will still be needed in Scope 2.
- In every case: the Rust serde DTOs (`model.rs`) remain the source of truth for the types; the TS
  in `core/models/` mirrors them.

---

## 7. Questions for the decision-maker

1. Do you expect **external contributors** during Phases 0–1? (pushes toward B)
2. Does a **visual/inspectable statechart** of the onboarding flow have value as security-audit
   documentation? (pushes toward D)
3. What is the target **bundle budget** for the webview? Is there an explicit ceiling?
4. Is there appetite to add **`@ngrx/*` as the frontend's first runtime dependency** now, or a
   preference to defer any dependency until there is concrete pressure?
5. Does the team have **prior experience with XState or NgRx**? (familiarity changes the real cost
   of B/C/D)
