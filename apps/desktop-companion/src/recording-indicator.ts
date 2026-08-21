export type IndicatorPhase = "recording" | "inactive" | "failed";

export type RecordingIndicatorSnapshot =
  | {
      readonly visibility: "persistent";
      readonly visible: true;
      readonly phase: Exclude<IndicatorPhase, "inactive">;
      readonly captureSessionId: string;
    }
  | {
      readonly visibility: "persistent";
      readonly visible: false;
      readonly phase: "inactive";
      readonly captureSessionId: null;
    };

export interface PersistentRecordingIndicator {
  publish(snapshot: RecordingIndicatorSnapshot): Promise<void>;
}

export class InMemoryRecordingIndicator implements PersistentRecordingIndicator {
  readonly history: RecordingIndicatorSnapshot[] = [];

  publish(snapshot: RecordingIndicatorSnapshot): Promise<void> {
    this.history.push(Object.freeze({ ...snapshot }));
    return Promise.resolve();
  }

  current(): RecordingIndicatorSnapshot | undefined {
    return this.history.at(-1);
  }
}
