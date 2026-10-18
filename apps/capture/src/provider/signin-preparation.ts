/** Native-only speculative auth. It carries no token, consent or capture grant. */
export interface ProviderSignInPreparation {
  prepare(signal: AbortSignal): Promise<void>;
  abandon(): Promise<void>;
}

/** Bind an opaque, cancelable setup owner to an already-authorized mount. */
export function scopedSignInPreparation(options: {
  readonly signal: AbortSignal;
  readonly current: () => void;
  readonly prepare: (id: string, signal: AbortSignal) => Promise<void>;
  readonly abandon: (id: string) => Promise<void>;
}): ProviderSignInPreparation {
  type Owner = { id: string; abort: AbortController; pending?: Promise<void>; signals: Map<AbortSignal, () => void> };
  let owner: Owner | null = null;
  let settling = Promise.resolve();
  const abandon = (): Promise<void> => {
    const old = owner; owner = null;
    if (!old) return settling;
    old.abort.abort();
    for (const [signal, cancel] of old.signals) signal.removeEventListener("abort", cancel);
    // Send the exact cancel immediately, even if the prepare reply is pending.
    // Native also remembers cancel-before-prepare for this opaque ID.
    const stopped = Promise.resolve().then(() => options.abandon(old.id));
    settling = Promise.allSettled([settling, stopped, old.pending?.catch(() => undefined)]).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    void settling.catch(() => undefined);
    return settling;
  };
  options.signal.addEventListener("abort", () => { void abandon().catch(() => undefined); }, { once: true });
  return {
    abandon,
    prepare: signal => {
      options.current();
      if (options.signal.aborted || signal.aborted) return Promise.reject(new Error("Sign-in preparation canceled."));
      const active: Owner = owner ??= { id: crypto.randomUUID(), abort: new AbortController(), signals: new Map() };
      if (!active.signals.has(signal)) {
        const cancel = (): void => { if (owner === active) void abandon().catch(() => undefined); };
        active.signals.set(signal, cancel); signal.addEventListener("abort", cancel, { once: true });
      }
      if (active.pending) return active.pending;
      const prepared = settling.then(async () => {
        options.current();
        if (owner !== active || active.abort.signal.aborted || signal.aborted) throw new Error("Sign-in preparation canceled.");
        await options.prepare(active.id, AbortSignal.any([options.signal, active.abort.signal]));
        options.current();
        if (owner !== active || active.abort.signal.aborted) throw new Error("Sign-in preparation canceled.");
      });
      active.pending = prepared;
      void prepared.finally(() => { if (active.pending === prepared) delete active.pending; }).catch(() => undefined);
      return prepared;
    },
  };
}

/** Setup callbacks are event-driven. Metadata polling never calls this owner. */
export function setupSignInPreparation(handle: ProviderSignInPreparation | undefined, current: () => boolean): {
  ready(): void; invalidate(): void; handoff(signal: AbortSignal): void; close(): void;
} {
  let closed = false, handedOff = false, active = new AbortController();
  const ready = (): void => {
    if (!handle || closed || handedOff || !current()) return;
    const signal = active.signal;
    void Promise.resolve().then(() => {
      if (!closed && !handedOff && !signal.aborted && current()) return handle.prepare(signal);
    }).catch(() => undefined); // Advisory; ordinary admission remains available.
  };
  const invalidate = (): void => {
    if (closed || handedOff) return;
    active.abort(); active = new AbortController();
    void handle?.abandon().catch(() => undefined);
  };
  return {
    ready, invalidate,
    handoff: signal => {
      if (!handle || closed || handedOff || !current() || signal.aborted) return;
      handedOff = true;
      // Refresh/join before the existing consent close+persist barrier. No new
      // wait, and the fresh recording-action signal owns subsequent cancel.
      void Promise.resolve().then(() => {
        if (!signal.aborted && current()) return handle.prepare(signal);
      }).catch(() => undefined);
    },
    close: () => { if (!closed) { invalidate(); closed = true; } },
  };
}
