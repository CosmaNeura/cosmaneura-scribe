import { ELECTRON_IPC_SCHEMA_VERSION } from "./config.js";
import {
  CompanionControllerError,
  type DesktopCaptureController,
} from "./controller.js";
import {
  parseControllerStateEvent,
  parseGetStateRequest,
  parseIpcCommandResult,
  parseMetadataIdentifier,
  parseRendererCommand,
  ProtocolValidationError,
  type BackendCaptureGrant,
  type ControllerStateEvent,
  type FailureCode,
  type IpcCommandResult,
  type RendererCommand,
  type RendererCommandKind,
} from "./protocol.js";

export const ELECTRON_IPC_CHANNELS = Object.freeze({
  getState: "cosmas:desktop:get-state:v1",
  refreshPermissions: "cosmas:desktop:refresh-permissions:v1",
  start: "cosmas:desktop:start:v1",
  stop: "cosmas:desktop:stop:v1",
  stateChanged: "cosmas:desktop:state-changed:v1",
});

const PACKAGED_RENDERER_ORIGIN = "app://cosmas" as const;

type InvokeChannel = Exclude<
  (typeof ELECTRON_IPC_CHANNELS)[keyof typeof ELECTRON_IPC_CHANNELS],
  typeof ELECTRON_IPC_CHANNELS.stateChanged
>;

interface ElectronFrame {
  readonly url: string;
}

interface ElectronInvokeEvent {
  readonly sender: {
    readonly id: number;
    readonly mainFrame: ElectronFrame;
  };
  readonly senderFrame: ElectronFrame | null;
}

export interface ElectronIpcMainPort {
  handle(
    channel: InvokeChannel,
    listener: (event: ElectronInvokeEvent, payload: unknown) => Promise<unknown>,
  ): void;
  removeHandler(channel: InvokeChannel): void;
}

export interface ElectronRendererTarget {
  readonly id: number;
  send(channel: typeof ELECTRON_IPC_CHANNELS.stateChanged, payload: unknown): void;
}

export interface ElectronIpcRendererPort {
  invoke(channel: InvokeChannel, payload: unknown): Promise<unknown>;
  on(
    channel: typeof ELECTRON_IPC_CHANNELS.stateChanged,
    listener: (event: unknown, payload: unknown) => void,
  ): void;
  removeListener(
    channel: typeof ELECTRON_IPC_CHANNELS.stateChanged,
    listener: (event: unknown, payload: unknown) => void,
  ): void;
}

export interface ElectronContextBridgePort {
  exposeInMainWorld(name: "cosmasDesktop", api: ElectronRendererApi): void;
}

export interface ElectronRendererApi {
  getState(): Promise<ControllerStateEvent>;
  refreshPermissions(): Promise<IpcCommandResult>;
  start(): Promise<IpcCommandResult>;
  stop(): Promise<IpcCommandResult>;
  onStateChanged(listener: (event: ControllerStateEvent) => void): () => void;
}

export class ElectronMainIpcBoundary {
  readonly #ipcMain: ElectronIpcMainPort;
  readonly #renderer: ElectronRendererTarget;
  readonly #controller: DesktopCaptureController;
  readonly #unsubscribeState: () => void;
  #installed = false;

  constructor(
    ipcMain: ElectronIpcMainPort,
    renderer: ElectronRendererTarget,
    controller: DesktopCaptureController,
  ) {
    this.#ipcMain = ipcMain;
    this.#renderer = renderer;
    this.#controller = controller;
    this.#unsubscribeState = this.#controller.subscribe((event) => {
      this.#renderer.send(
        ELECTRON_IPC_CHANNELS.stateChanged,
        parseControllerStateEvent(event),
      );
    });
  }

  install(): void {
    if (this.#installed) {
      throw new Error("Electron IPC boundary is already installed");
    }
    this.#installed = true;
    this.#ipcMain.handle(
      ELECTRON_IPC_CHANNELS.getState,
      (event, payload) => {
        this.#assertRenderer(event);
        parseGetStateRequest(payload);
        return Promise.resolve(this.#controller.snapshot());
      },
    );
    this.#installCommand(
      ELECTRON_IPC_CHANNELS.refreshPermissions,
      "refresh_permissions",
    );
    this.#installCommand(ELECTRON_IPC_CHANNELS.start, "start");
    this.#installCommand(ELECTRON_IPC_CHANNELS.stop, "stop");
  }

  /** Called only by trusted main-process backend orchestration. */
  async initializeFromBackend(
    grant: BackendCaptureGrant,
    requestId: string,
  ): Promise<IpcCommandResult> {
    return this.#run(requestId, async () =>
      this.#controller.initializeFromBackend(grant, requestId),
    );
  }

  /** Called only during Electron application shutdown. */
  async shutdownFromMain(requestId: string): Promise<IpcCommandResult> {
    return this.#run(requestId, async () =>
      this.#controller.shutdownFromMain(requestId),
    );
  }

  dispose(): void {
    for (const channel of [
      ELECTRON_IPC_CHANNELS.getState,
      ELECTRON_IPC_CHANNELS.refreshPermissions,
      ELECTRON_IPC_CHANNELS.start,
      ELECTRON_IPC_CHANNELS.stop,
    ] as const) {
      this.#ipcMain.removeHandler(channel);
    }
    this.#unsubscribeState();
    this.#installed = false;
  }

  #installCommand(channel: InvokeChannel, kind: RendererCommandKind): void {
    this.#ipcMain.handle(channel, async (event, payload) => {
      this.#assertRenderer(event);
      const request = parseRendererRequest(payload, kind);
      return this.#run(request.requestId, async () =>
        this.#controller.handleRendererCommand(request),
      );
    });
  }

  async #run(
    requestId: string,
    operation: () => Promise<void>,
  ): Promise<IpcCommandResult> {
    const validatedRequestId = parseMetadataIdentifier(requestId);
    try {
      await operation();
      return Object.freeze({
        schemaVersion: ELECTRON_IPC_SCHEMA_VERSION,
        requestId: validatedRequestId,
        ok: true,
        errorCode: null,
      });
    } catch (error) {
      return Object.freeze({
        schemaVersion: ELECTRON_IPC_SCHEMA_VERSION,
        requestId: validatedRequestId,
        ok: false,
        errorCode: errorCodeFor(error),
      });
    }
  }

  #assertRenderer(event: ElectronInvokeEvent): void {
    if (
      event.sender.id !== this.#renderer.id ||
      event.senderFrame === null ||
      event.senderFrame !== event.sender.mainFrame ||
      !hasExpectedOrigin(event.senderFrame.url)
    ) {
      throw new CompanionControllerError("renderer_unauthorized");
    }
  }
}

export function createElectronRendererApi(
  ipcRenderer: ElectronIpcRendererPort,
  requestIdFactory: () => string = () => globalThis.crypto.randomUUID(),
): ElectronRendererApi {
  const invokeCommand = async (
    channel: InvokeChannel,
    kind: RendererCommandKind,
  ): Promise<IpcCommandResult> => {
    const command = parseRendererCommand({
      schemaVersion: ELECTRON_IPC_SCHEMA_VERSION,
      kind,
      requestId: requestIdFactory(),
    });
    return parseIpcCommandResult(await ipcRenderer.invoke(channel, command));
  };

  return Object.freeze({
    async getState(): Promise<ControllerStateEvent> {
      const request = Object.freeze({
        schemaVersion: ELECTRON_IPC_SCHEMA_VERSION,
        requestId: parseMetadataIdentifier(requestIdFactory()),
      });
      return parseControllerStateEvent(
        await ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.getState, request),
      );
    },
    refreshPermissions: async () =>
      invokeCommand(
        ELECTRON_IPC_CHANNELS.refreshPermissions,
        "refresh_permissions",
      ),
    start: async () => invokeCommand(ELECTRON_IPC_CHANNELS.start, "start"),
    stop: async () => invokeCommand(ELECTRON_IPC_CHANNELS.stop, "stop"),
    onStateChanged(listener: (event: ControllerStateEvent) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        listener(parseControllerStateEvent(payload));
      };
      ipcRenderer.on(ELECTRON_IPC_CHANNELS.stateChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(ELECTRON_IPC_CHANNELS.stateChanged, wrapped);
      };
    },
  });
}

export function installElectronPreloadBridge(
  contextBridge: ElectronContextBridgePort,
  ipcRenderer: ElectronIpcRendererPort,
): void {
  contextBridge.exposeInMainWorld(
    "cosmasDesktop",
    createElectronRendererApi(ipcRenderer),
  );
}

function parseRendererRequest(
  payload: unknown,
  expectedKind: RendererCommandKind,
): RendererCommand {
  const command = parseRendererCommand(payload);
  if (command.kind !== expectedKind) {
    throw new ProtocolValidationError();
  }
  return command;
}

function hasExpectedOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(PACKAGED_RENDERER_ORIGIN);
    return (
      parsed.protocol === expected.protocol &&
      parsed.hostname === expected.hostname &&
      parsed.port === expected.port &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function errorCodeFor(error: unknown): FailureCode {
  if (error instanceof CompanionControllerError) {
    return error.code;
  }
  return "precondition_failed";
}
