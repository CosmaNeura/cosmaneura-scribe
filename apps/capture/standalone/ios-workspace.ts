import { mountNativeProviderIOSApplication } from "../src/provider/native-application";
import { HttpCiphertextUploadTarget } from "../src/bff/upload-target";
import { nativeProviderPlugin as native, type StandaloneProviderNative } from "../src/provider/native-plugin";

export function mount(root: HTMLElement,
  configuration: Awaited<ReturnType<StandaloneProviderNative["getProviderConfiguration"]>>): () => Promise<void> {
  return mountNativeProviderIOSApplication(root, {
    uploadTarget: new HttpCiphertextUploadTarget(configuration.uploadOrigins, fetch, "azure_block_blob"),
    core: {
      createEncounter: signal => { signal.throwIfAborted(); return native.openProviderCore({ appointmentRef: null }); },
      openEncounter: (appointmentRef, _note, signal) => { signal.throwIfAborted(); return native.openProviderCore({ appointmentRef }); },
    },
  });
}
