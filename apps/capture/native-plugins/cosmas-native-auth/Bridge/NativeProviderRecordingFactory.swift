#if os(iOS)
  import CosmaneuraIOSAVFoundationDriver
  import CosmaneuraIOSPCMCore
  import CosmaneuraNativeRecording
  import CosmaneuraNativeRecordingPCM
  import CosmaneuraSecureQueue
  import CosmasNativeAuth
  import Foundation

  extension NativeProviderRecordingHost {
    /// Context and recovery namespace come from the same authenticated Core
    /// connection as the provider screen. The caller retains this host before
    /// awaiting open(), including on failure, until close() succeeds.
    static func make(
      connection: NativeProviderConnection, auth: NativeWorkspaceAuth,
      recovery: NativeSourceRecovery, workspaceID: UUID, bindingRef: String,
      sessionID: UUID, revision: String, authorizationID: UUID? = nil
    ) async throws -> NativeProviderRecordingHost {
      let mount = try connection.recordingMount(
        workspaceID: workspaceID, bindingRef: bindingRef, revision: revision)
      let prepared = try authorizationID.flatMap {
        try connection.takePreparedRecordingContext(
          nonce: $0, workspaceID: workspaceID,
          bindingRef: bindingRef, sessionID: sessionID, revision: revision)
      }
      let context: NativeProviderRecordingContext
      if let prepared {
        context = prepared
      } else {
        context = try await connection.recordingContext(
          workspaceID: workspaceID, bindingRef: bindingRef, sessionID: sessionID, revision: revision
        )
      }
      guard
        try connection.recordingMount(
          workspaceID: workspaceID, bindingRef: bindingRef, revision: revision) == mount
      else { throw ProviderNativeError.authorityChanged }
      let service = NativeProviderRecordingService(connection: connection, context: context)
      let scope = try await service.recordingScope()
      let records = try NativeRecordingQueueStore()
      return NativeProviderRecordingHost(
        scope: scope, recoveryScope: mount.recoveryScope, service: service, records: records,
        requireCurrent: {
          _ = try connection.recordingRevision(accountDigest: scope.accountDigest)
        },
        recoverSources: { try await recovery.recover(connection: connection) },
        makeSource: { lease, batch in
          let revision = try connection.recordingRevision(accountDigest: scope.accountDigest)
          guard let identity = auth.state().identity, auth.state().revision == revision,
            let first = batch.reservations.first?.sequence
          else { throw ProviderNativeError.unavailable }
          try recovery.requireReady()
          let preparation = try NativeSourcePreparation(
            workspaceID: scope.workspaceID, bindingRef: bindingRef, sessionID: scope.sessionID,
            leaseID: lease.leaseID, leaseReceiptID: lease.receiptID,
            leaseGeneration: lease.generation,
            captureAuthorizedUntil: lease.expiresAt, source: .ios, firstSequenceNumber: first)
          return try NativeSourceStartOwner(
            connection: connection, revision: revision, preparation: preparation,
            identity: identity, journal: recovery.journal,
            stopRevision: { try connection.stopRevision(for: identity) })
        },
        makeRun: { source, encryption, priorBytes, lease, batch, leases, reservations, input in
          let permission = LiveAppleMicrophonePermissionProvider()
          let signal = PCMSignalMonitor()
          return try NativeProviderRecordingRun(
            source: source, lease: lease, batch: batch,
            requestPermission: {
              if permission.currentPermission() == .granted { return true }
              return await permission.requestPermission() == .granted
            },
            makeRecorder: { validate in
              try NativeEncryptedPCMRecorder(
                encryption: encryption, recoveryScope: mount.recoveryScope, records: records,
                firstSequence: source.recordingPreparation.firstSequenceNumber,
                priorPlaintextBytes: priorBytes, leases: leases, reservations: reservations,
                permission: AVFoundationMicrophonePermissionAdapter(provider: permission),
                system: LiveAppleAudioSystem(signalMonitor: signal, microphoneInput: input),
                foreground: LiveAppleApplicationForegroundProvider(), signal: signal,
                validateActiveSource: validate)
            })
        })
    }
  }
#endif
