import type {
  PersistentRecordingIndicator,
  RecordingIndicatorSnapshot,
} from "./recording-indicator.js";

const RECORDING_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAWElEQVR42u3W2w0AIAhDUTdi/zkcSFdAHqExtwnfPX90LUIess2O58aKWyDR8hJEtjyFqCoPIarLnxGjgK5yNwIAAAAAxgH8Aol3LDFIJCaZxCiVmOXk61yzjyL9WK9rFQAAAABJRU5ErkJggg==";
const FAILED_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiklEQVR42u3WSwqAMAwE0BzCa7j24B4w0kVBSqv5tSOYgWydp/0gUSaTcYRP4jL/BNRyGAIKaMuXI459495Ay5cg3sqnI6CAssmkgCkbEgqox0wDCEPcz7kWEIKAAtqbzgJwIUZXrnag5WZE7yHWJVADRm/hAYgRT5/RCxAhotdeBZhdDv+JzXwyF7tWf01rTx5kAAAAAElFTkSuQmCC";

export interface ElectronNativeImagePort {
  isEmpty(): boolean;
}

export interface ElectronTrayPort {
  destroy(): void;
  on(event: "click", listener: () => void): void;
  setContextMenu(menu: unknown): void;
  setImage(image: ElectronNativeImagePort): void;
  setToolTip(toolTip: string): void;
}

export interface ElectronTrayFactoryPort {
  create(image: ElectronNativeImagePort): ElectronTrayPort;
}

export interface ElectronNativeImageFactoryPort {
  createFromDataURL(dataUrl: string): ElectronNativeImagePort;
}

export interface ElectronMenuFactoryPort {
  buildFromTemplate(template: readonly ElectronMenuTemplateItem[]): unknown;
}

export type ElectronMenuTemplateItem = Readonly<
  | { label: string; enabled: false }
  | { type: "separator" }
  | { label: string; click: () => void }
>;

export interface CaptureSafetySignalPort {
  isSafetySignalVisible(): boolean;
}

export class ElectronTrayRecordingIndicator
  implements PersistentRecordingIndicator, CaptureSafetySignalPort
{
  readonly #trayFactory: ElectronTrayFactoryPort;
  readonly #imageFactory: ElectronNativeImageFactoryPort;
  readonly #menuFactory: ElectronMenuFactoryPort;
  readonly #activateWindow: () => void;
  #tray: ElectronTrayPort | null = null;
  #safetyVisible = false;

  constructor(options: {
    readonly trayFactory: ElectronTrayFactoryPort;
    readonly imageFactory: ElectronNativeImageFactoryPort;
    readonly menuFactory: ElectronMenuFactoryPort;
    readonly activateWindow: () => void;
  }) {
    this.#trayFactory = options.trayFactory;
    this.#imageFactory = options.imageFactory;
    this.#menuFactory = options.menuFactory;
    this.#activateWindow = options.activateWindow;
  }

  publish(snapshot: RecordingIndicatorSnapshot): Promise<void> {
    if (!snapshot.visible) {
      this.#tray?.destroy();
      this.#tray = null;
      this.#safetyVisible = false;
      return Promise.resolve();
    }

    const image = this.#imageFactory.createFromDataURL(
      snapshot.phase === "recording" ? RECORDING_ICON : FAILED_ICON,
    );
    if (image.isEmpty()) {
      return Promise.reject(new Error("Native recording indicator is unavailable"));
    }
    if (this.#tray === null) {
      this.#tray = this.#trayFactory.create(image);
      this.#tray.on("click", this.#activateWindow);
    } else {
      this.#tray.setImage(image);
    }
    this.#safetyVisible = true;

    const recording = snapshot.phase === "recording";
    const status = recording
      ? "Recording is active"
      : "Capture status is uncertain";
    this.#tray.setToolTip(`Cosmas — ${status}`);
    this.#tray.setContextMenu(
      this.#menuFactory.buildFromTemplate([
        Object.freeze({ label: status, enabled: false }),
        Object.freeze({ type: "separator" }),
        Object.freeze({ label: "Open Cosmas", click: this.#activateWindow }),
      ]),
    );
    return Promise.resolve();
  }

  isSafetySignalVisible(): boolean {
    return this.#safetyVisible;
  }
}

export interface ElectronCaptureWindowGuardPort {
  focus(): void;
  show(): void;
  on(
    event: "close" | "minimize",
    listener: (event: { preventDefault(): void }) => void,
  ): void;
}

export function installCaptureWindowGuard(
  window: ElectronCaptureWindowGuardPort,
  indicator: CaptureSafetySignalPort,
  isShutdownStarted: () => boolean,
): void {
  for (const eventName of ["close", "minimize"] as const) {
    window.on(eventName, (event) => {
      if (isShutdownStarted() || !indicator.isSafetySignalVisible()) {
        return;
      }
      event.preventDefault();
      window.show();
      window.focus();
    });
  }
}
