import Foundation
import Testing
@testable import ScribeDesktopAudio

// Only invented metadata enters this seam. It has no microphone authorization,
// native source, recording grant, UI, storage or network dependency.
@Test @MainActor
func deniedScreenAccessNeverRunsWindowMetadataLookup() async throws {
    var lookups = 0
    await #expect(throws: ProviderPresentationFailure.screenAccessDenied) {
        _ = try await providerMeetingWindows(screenCaptureAuthorized: false) {
            lookups += 1
            return []
        }
    }
    #expect(lookups == 0)
    #expect(ProviderPresentationFailure.screenAccessDenied.windowDiscoveryDiagnostic == "screen_access_denied")
}

@Test @MainActor
func screenAuthorizedMetadataDoesNotDependOnMicrophoneOrCreateAudio() async throws {
    var lookups = 0
    let selection = try MeetingAudioSelection(application: .chrome, processID: 42, windowID: 74)
    let rows = try await providerMeetingWindows(screenCaptureAuthorized: true) {
        lookups += 1
        return [ProviderMeetingWindow(selection: selection, title: "Chrome — Synthetic visit")]
    }
    #expect(lookups == 1 && rows.count == 1)
    #expect(rows.first?.selection == selection)
    #expect(rows.first?.title == "Chrome — Synthetic visit")
}

@Test @MainActor
func windowLookupFailureUsesOnlyTheFixedDiagnostic() async throws {
    await #expect(throws: ProviderPresentationFailure.windowDiscoveryFailed) {
        _ = try await providerMeetingWindows(screenCaptureAuthorized: true) {
            throw NSError(domain: "invented-private-window-detail", code: 42)
        }
    }
    #expect(ProviderPresentationFailure.windowDiscoveryFailed.windowDiscoveryDiagnostic == "lookup_failed")
    #expect(ProviderPresentationFailure.unavailable.windowDiscoveryDiagnostic == nil)
}

@Test @MainActor
func windowMetadataStillEnforcesTheSixtyFourWindowLimit() async throws {
    let selection = try MeetingAudioSelection(application: .zoom, processID: 42, windowID: 74)
    await #expect(throws: ProviderPresentationFailure.windowLimitExceeded) {
        _ = try await providerMeetingWindows(screenCaptureAuthorized: true) {
            Array(repeating: ProviderMeetingWindow(selection: selection, title: "Zoom — Synthetic visit"), count: 65)
        }
    }
    #expect(ProviderPresentationFailure.windowLimitExceeded.windowDiscoveryDiagnostic == "window_limit_exceeded")
}

@Test @MainActor
func cancelledMetadataRequestNeverRunsItsLookup() async throws {
    var lookups = 0
    let task = Task { @MainActor in
        try await providerMeetingWindows(screenCaptureAuthorized: true) {
            lookups += 1
            return []
        }
    }
    task.cancel()
    await #expect(throws: CancellationError.self) { _ = try await task.value }
    #expect(lookups == 0)
}

@Test @MainActor
func cancelledLookupCannotReturnStaleWindowMetadata() async throws {
    let task = Task { @MainActor in
        try await providerMeetingWindows(screenCaptureAuthorized: true) {
            withUnsafeCurrentTask { $0?.cancel() }
            return []
        }
    }
    await #expect(throws: CancellationError.self) { _ = try await task.value }
}

// A visible browser window can host documentation or any ordinary page.
// Window discovery does not require a video call or a call-related title.
@Test @MainActor
func ordinaryChromeWindowDoesNotNeedAVideoCallTitle() async throws {
    var lookups = 0
    let selection = try MeetingAudioSelection(application: .chrome, processID: 42, windowID: 75)
    let rows = try await providerMeetingWindows(screenCaptureAuthorized: true) {
        lookups += 1
        return [ProviderMeetingWindow(selection: selection, title: "Chrome — Synthetic documentation page")]
    }
    #expect(lookups == 1 && rows.count == 1)
    #expect(rows.first?.selection == selection)
    #expect(rows.first?.title == "Chrome — Synthetic documentation page")
}
