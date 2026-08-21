export class RecordingLeaseUnavailableError extends Error {
  constructor() {
    super("Another desktop capture is active");
    this.name = "RecordingLeaseUnavailableError";
  }
}

export type RecordingLeaseOwner = symbol;

export function createRecordingLeaseOwner(): RecordingLeaseOwner {
  return Symbol("desktop-capture-controller");
}

export class SingleRecordingLease {
  #owner: RecordingLeaseOwner | null = null;

  acquire(owner: RecordingLeaseOwner): void {
    if (this.#owner !== null && this.#owner !== owner) {
      throw new RecordingLeaseUnavailableError();
    }
    this.#owner = owner;
  }

  release(owner: RecordingLeaseOwner): void {
    if (this.#owner === owner) {
      this.#owner = null;
    }
  }

  isHeldBy(owner: RecordingLeaseOwner): boolean {
    return this.#owner === owner;
  }
}

export const processRecordingLease = new SingleRecordingLease();
