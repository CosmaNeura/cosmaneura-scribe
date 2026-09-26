import Capacitor
import Foundation

@objc(SecureQueuePlugin)
public final class SecureQueuePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureQueuePlugin"
    public let jsName = "SecureQueue"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStorageCapacity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "put", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "compareAndSwap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private let operationQueue = DispatchQueue(
        label: "com.cosmaneura.capture.secure-queue.operations",
        qos: .utility
    )
    private var store: RendererSecureQueueStore?

    public override func load() {
        store = try? RendererSecureQueueStore(store: SecureQueueStore.shared.get())
    }

    @objc public func getStorageCapacity(_ call: CAPPluginCall) {
        perform(call) { store in
            ["availableBytes": String(try store.availableBytes())]
        }
    }

    @objc public func put(_ call: CAPPluginCall) {
        guard
            let key = call.getString("key"),
            let encoded = call.getString("data"),
            let data = Data(base64Encoded: encoded),
            data.base64EncodedString() == encoded
        else {
            reject(call, with: .invalidArgument)
            return
        }
        perform(call) { store in
            ["revision": String(try store.put(key: key, data: data))]
        }
    }

    @objc public func create(_ call: CAPPluginCall) {
        guard
            let key = call.getString("key"),
            let encoded = call.getString("data"),
            let data = Data(base64Encoded: encoded),
            data.base64EncodedString() == encoded
        else {
            reject(call, with: .invalidArgument)
            return
        }
        perform(call) { store in
            ["revision": String(try store.create(key: key, data: data))]
        }
    }

    @objc public func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            reject(call, with: .invalidArgument)
            return
        }
        perform(call) { store in
            let record = try store.get(key: key)
            return [
                "key": record.key,
                "data": record.data.base64EncodedString(),
                "revision": String(record.revision),
            ]
        }
    }

    @objc public func list(_ call: CAPPluginCall) {
        perform(call) { store in
            ["keys": try store.list()]
        }
    }

    @objc public func compareAndSwap(_ call: CAPPluginCall) {
        guard
            let key = call.getString("key"),
            let expected = call.getString("expectedRevision"),
            let expectedRevision = UInt64(expected),
            expectedRevision > 0,
            expectedRevision <= SecureQueueRecordCodec.maximumRevision,
            String(expectedRevision) == expected,
            let encoded = call.getString("data"),
            let data = Data(base64Encoded: encoded),
            data.base64EncodedString() == encoded
        else {
            reject(call, with: .invalidArgument)
            return
        }
        perform(call) { store in
            [
                "revision": String(
                    try store.compareAndSwap(
                        key: key,
                        expectedRevision: expectedRevision,
                        data: data
                    )
                ),
            ]
        }
    }

    @objc public func delete(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            reject(call, with: .invalidArgument)
            return
        }
        perform(call) { store in
            ["deleted": try store.delete(key: key)]
        }
    }

    @objc public func clear(_ call: CAPPluginCall) {
        perform(call) { store in
            ["cleared": try store.clear()]
        }
    }

    private func perform(
        _ call: CAPPluginCall,
        operation: @escaping (RendererSecureQueueStore) throws -> JSObject?
    ) {
        operationQueue.async { [weak self] in
            guard let self, let store = self.store else {
                self?.reject(call, with: .keyUnavailable)
                return
            }
            do {
                if let result = try operation(store) {
                    call.resolve(result)
                } else {
                    call.resolve()
                }
            } catch let error as SecureQueueError {
                self.reject(call, with: error)
            } catch {
                self.reject(call, with: .io)
            }
        }
    }

    private func reject(_ call: CAPPluginCall, with error: SecureQueueError) {
        call.reject(error.publicMessage, error.code)
    }
}
