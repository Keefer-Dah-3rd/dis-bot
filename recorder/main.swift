// Mibbit Meeting Recorder
//
// Records a call on this Mac into two files so it can be transcribed afterwards:
//   system.caf  what the call app is playing (the other people in the call)
//   mic.caf     the default microphone (you)
//
// Usage:  open "Mibbit Meeting Recorder.app" --args <output-folder> [app ...]
//         Records Discord unless other apps are named, by bundle-id prefix (us.zoom)
//         or, for command-line players, by program name (afplay).
// Stop:   the menu-bar item, `kill -TERM <pid>`, or create a file named "stop" in the output folder.
//
// status.json in the output folder is rewritten every 2 seconds with levels, so
// whoever started the recording can check that sound is really arriving.
//
// Two things it is careful about, both learned from a real meeting:
//   - Both files keep time by the Mac's clock. If the Mac is too busy to deliver
//     some audio, the gap is filled with silence instead of being closed up, so
//     the two tracks never slide apart.
//   - The call app's sound can stop reaching us mid-call (the app restarts its
//     audio, the output device changes). A watchdog notices and reconnects.
//   - The recording doesn't lean on any speaker or display: unplugging one, or
//     one running at a different sample rate, can't slow the call down or silence it.

import AppKit
import AudioToolbox
import AVFoundation
import CoreAudio

struct RecorderError: Error, CustomStringConvertible {
    let description: String
}

func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr { throw RecorderError(description: "\(what) failed (\(status))") }
}

func pcm16Settings(_ format: AVAudioFormat) -> [String: Any] {
    [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: format.sampleRate,
        AVNumberOfChannelsKey: format.channelCount,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
    ]
}

func peak(of buffer: AVAudioPCMBuffer) -> Float {
    guard let channels = buffer.floatChannelData else { return 0 }
    let frames = Int(buffer.frameLength)
    let count = buffer.format.isInterleaved ? 1 : Int(buffer.format.channelCount)
    let perChannel = buffer.format.isInterleaved ? frames * Int(buffer.format.channelCount) : frames
    var top: Float = 0
    for c in 0..<count {
        let samples = channels[c]
        var i = 0
        while i < perChannel {
            let v = abs(samples[i])
            if v > top { top = v }
            i += 4 // every 4th sample is plenty for a level meter
        }
    }
    return top
}

func decibels(_ linear: Float) -> Double {
    linear <= 0.000001 ? -120 : Double(20 * log10(linear))
}

func hostSeconds(_ hostTime: UInt64) -> Double {
    AVAudioTime.seconds(forHostTime: hostTime)
}

/// A copy that outlives the audio callback it arrived in.
func copy(of buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return nil }
    out.frameLength = buffer.frameLength
    let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
    let target = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
    for (s, t) in zip(source, target) {
        guard let from = s.mData, let to = t.mData else { return nil }
        memcpy(to, from, Int(min(s.mDataByteSize, t.mDataByteSize)))
    }
    return out
}

/// One audio file that keeps time by the Mac's clock.
///
/// Every buffer says when it was captured. If the file is behind that moment
/// (audio was dropped, capture was restarted, the device runs slow), silence is
/// written to catch up, so a position in the file always means the same moment
/// of the meeting. All calls happen on `queue`.
final class Track {
    let name: String
    let queue: DispatchQueue
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var fileFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var converterSource: AVAudioFormat?
    private var epoch: Double?           // clock time of the file's first frame
    private var written: Int64 = 0       // frames in the file, padding included
    private var padded: Int64 = 0        // frames of that which are padding
    private var closed = false
    private var source = 0               // the newest connection heard from; older ones are ignored

    // Read from other threads, under `lock`.
    private var firstAudioAt: Date?
    private var peakNow: Float = 0
    private var peakEver: Float = 0
    private var lastBuffer = Date.distantPast
    private var lastSound = Date.distantPast

    init(name: String) {
        self.name = name
        queue = DispatchQueue(label: "io.mibbit.recorder.\(name)")
    }

    /// Called from an audio callback: copies the buffer and hands it to the writer.
    /// `source` numbers the connection the buffer came from: once a newer one has been
    /// heard from, an older one that is still winding down is ignored, so a reconnect
    /// can overlap the old connection without anything being written twice.
    func capture(_ buffer: AVAudioPCMBuffer, hostTime: UInt64, into url: URL, source: Int = 0) {
        guard buffer.frameLength > 0, let owned = copy(of: buffer) else { return }
        let now = hostSeconds(mach_absolute_time())
        let at = hostTime == 0 ? now : hostSeconds(hostTime)
        let wall = Date().addingTimeInterval(-max(now - at, 0))
        queue.async { self.append(owned, at: at, wall: wall, url: url, source: source) }
    }

    private func append(_ incoming: AVAudioPCMBuffer, at time: Double, wall: Date, url: URL, source from: Int) {
        if closed { return } // a late buffer must not reopen, and so wipe, a finished file
        if from < source { return }
        source = from
        do {
            if file == nil {
                let created = try AVAudioFile(forWriting: url, settings: pcm16Settings(incoming.format),
                                              commonFormat: .pcmFormatFloat32, interleaved: incoming.format.isInterleaved)
                file = created
                fileFormat = created.processingFormat
                epoch = time
                lock.lock(); firstAudioAt = wall; lock.unlock()
            }
            guard let file, let fileFormat, let epoch else { return }

            // Capture restarted with a different format (new device): convert to the file's.
            var buffer = incoming
            if incoming.format != fileFormat {
                if converterSource != incoming.format {
                    converter = AVAudioConverter(from: incoming.format, to: fileFormat)
                    converterSource = incoming.format
                }
                guard let converter, let converted = convert(incoming, with: converter, to: fileFormat) else { return }
                buffer = converted
            }

            let due = Int64((time - epoch) * fileFormat.sampleRate)
            let behind = due - written
            if behind > Int64(fileFormat.sampleRate * 0.1) {
                try writeSilence(behind, to: file, format: fileFormat)
            }
            try file.write(from: buffer)
            written += Int64(buffer.frameLength)

            let level = peak(of: buffer)
            lock.lock()
            lastBuffer = Date()
            if level > 0.0005 { lastSound = lastBuffer }
            if level > peakNow { peakNow = level }
            if level > peakEver { peakEver = level }
            lock.unlock()
        } catch {
            FileHandle.standardError.write(Data("\(name): \(error)\n".utf8))
        }
    }

    private func writeSilence(_ frames: Int64, to file: AVAudioFile, format: AVAudioFormat) throws {
        var left = frames
        let chunk = AVAudioFrameCount(format.sampleRate)
        guard let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { return }
        for buffer in UnsafeMutableAudioBufferListPointer(silence.mutableAudioBufferList) {
            if let data = buffer.mData { memset(data, 0, Int(buffer.mDataByteSize)) }
        }
        while left > 0 {
            silence.frameLength = AVAudioFrameCount(min(Int64(chunk), left))
            try file.write(from: silence)
            left -= Int64(silence.frameLength)
        }
        written += frames
        padded += frames
    }

    private func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if fed { outStatus.pointee = .noDataNow; return nil }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        return status == .error ? nil : out
    }

    /// Finishes the file. Nothing may be captured into this track afterwards.
    func close() {
        queue.sync {
            closed = true
            file = nil
        }
    }

    /// Seconds since any audio arrived and since audible sound arrived, and whether any ever has.
    func quiet() -> (stalled: TimeInterval, silent: TimeInterval, everHeard: Bool) {
        lock.lock(); defer { lock.unlock() }
        let now = Date()
        return (now.timeIntervalSince(lastBuffer), now.timeIntervalSince(lastSound), lastBuffer != .distantPast)
    }

    func status(file fileName: String, iso: ISO8601DateFormatter) -> [String: Any] {
        let (frames, pad, rate) = queue.sync { (written, padded, fileFormat?.sampleRate ?? 0) }
        lock.lock(); defer { lock.unlock() }
        let report: [String: Any] = [
            "file": fileName,
            "firstAudioAt": firstAudioAt.map { iso.string(from: $0) } ?? NSNull(),
            "seconds": rate > 0 ? Double(frames) / rate : 0,
            "silenceAddedSeconds": rate > 0 ? Double(pad) / rate : 0,
            "peakDbLast2s": decibels(peakNow),
            "peakDbEver": decibels(peakEver),
        ]
        peakNow = 0
        return report
    }
}

final class Recorder {
    let outDir: URL
    /// Bundle-id prefixes of the apps whose sound is recorded. Discord by default.
    let appPrefixes: [String]
    private let lock = NSLock()

    private let system = Track(name: "system")
    private let mic = Track(name: "mic")
    private let engine = AVAudioEngine()
    private var configurationObserver: NSObjectProtocol?

    /// One connection to the call app's sound.
    private struct Capture {
        let tap: AudioObjectID
        let aggregate: AudioObjectID
        let ioProc: AudioDeviceIOProcID?
    }
    private var capture: Capture?
    private var connections = 0
    private let ioQueue = DispatchQueue(label: "io.mibbit.recorder.callback")
    private var tappedProcesses: Set<AudioObjectID> = []
    private var tappedOutput = ""
    private var tappedRate = 0.0
    private var lastConnect = Date.distantPast
    private var silentPatience: TimeInterval = 8
    private var reconnects = 0

    private(set) var startedAt = Date()
    private(set) var notes: [String] = []
    private var state = "starting"

    init(outDir: URL, appPrefixes: [String]) {
        self.outDir = outDir
        self.appPrefixes = appPrefixes
    }

    func note(_ text: String) {
        lock.lock()
        if notes.last != text { notes.append(text) }
        lock.unlock()
        FileHandle.standardError.write(Data("\(text)\n".utf8))
    }

    func markStarted() {
        startedAt = Date()
    }

    // ---------- the other people: what the call app plays ----------

    func startSystemAudio() throws {
        capture = try makeCapture()
    }

    private func makeCapture() throws -> Capture {
        // Record only the call app. Recording "everything the Mac plays" also picks up
        // other apps, and picks the call up twice when a virtual audio driver
        // (FonePaw's, for one) passes the sound on to the real speakers.
        let callApps = audioProcesses(withBundlePrefixes: appPrefixes)
        let description: CATapDescription
        if callApps.isEmpty {
            note("None of \(appPrefixes.joined(separator: ", ")) is playing sound, so everything the Mac plays is being recorded instead")
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        } else {
            description = CATapDescription(stereoMixdownOfProcesses: callApps)
        }
        description.uuid = UUID()
        description.name = "Mibbit Meeting Recorder"
        description.isPrivate = true
        description.muteBehavior = .unmuted // people keep hearing the call as normal

        var tap = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(description, &tap), "Creating the system-audio tap")
        var device = AudioObjectID(kAudioObjectUnknown)
        var proc: AudioDeviceIOProcID?
        do {
            var streamDescription = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            var formatAddress = AudioObjectPropertyAddress(
                mSelector: kAudioTapPropertyFormat,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            try check(AudioObjectGetPropertyData(tap, &formatAddress, 0, nil, &size, &streamDescription), "Reading the tap format")
            guard let format = AVAudioFormat(streamDescription: &streamDescription) else {
                throw RecorderError(description: "The system-audio format isn't usable")
            }

            // The recording device holds the tap and nothing else. Tying it to a real
            // output device (the usual recipe) makes it run on that device's clock:
            // when that was a display's speakers at another sample rate the call came
            // through 8% slow, and when the display went away the call went silent.
            let outputUID = (try? defaultOutputDeviceUID()) ?? ""
            let aggregate: [String: Any] = [
                kAudioAggregateDeviceNameKey: "Mibbit Meeting Recorder",
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceIsStackedKey: false,
                kAudioAggregateDeviceTapAutoStartKey: true,
                kAudioAggregateDeviceTapListKey: [[
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: description.uuid.uuidString,
                ]],
            ]
            try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "Creating the recording device")

            // The callback only copies the audio and hands it on: writing to disk here
            // made the Mac skip audio whenever it was busy.
            connections += 1
            let number = connections
            let track = system
            let url = outDir.appendingPathComponent("system.caf")
            try check(AudioDeviceCreateIOProcIDWithBlock(&proc, device, ioQueue) { now, input, inputTime, _, _ in
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
                let stamp = inputTime.pointee.mFlags.contains(.hostTimeValid) ? inputTime.pointee.mHostTime : now.pointee.mHostTime
                track.capture(buffer, hostTime: stamp, into: url, source: number)
            }, "Creating the audio callback")
            try check(AudioDeviceStart(device, proc), "Starting system-audio capture")

            tappedProcesses = Set(callApps)
            tappedOutput = outputUID
            tappedRate = format.sampleRate
            lastConnect = Date()
            return Capture(tap: tap, aggregate: device, ioProc: proc)
        } catch {
            destroy(Capture(tap: tap, aggregate: device, ioProc: proc)) // don't leave half a connection behind
            throw error
        }
    }

    private func destroy(_ capture: Capture) {
        if capture.aggregate != kAudioObjectUnknown {
            AudioDeviceStop(capture.aggregate, capture.ioProc)
            if let ioProc = capture.ioProc { AudioDeviceDestroyIOProcID(capture.aggregate, ioProc) }
            AudioHardwareDestroyAggregateDevice(capture.aggregate)
        }
        if capture.tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(capture.tap) }
    }

    private func stopSystemAudio() {
        if let capture { destroy(capture) }
        capture = nil
        ioQueue.sync {} // let a callback that was mid-flight finish
    }

    /// Called every couple of seconds: reconnects when the call's sound has stopped reaching us.
    func watchSystemAudio() {
        guard Date().timeIntervalSince(lastConnect) > 4 else { return }
        let apps = Set(audioProcesses(withBundlePrefixes: appPrefixes))
        let output = (try? defaultOutputDeviceUID()) ?? tappedOutput
        let (stalled, silent, everHeard) = system.quiet()
        let sinceConnect = Date().timeIntervalSince(lastConnect)

        var reason: String?
        var worthNoting = true
        if apps != tappedProcesses {
            reason = "the call app's audio changed"
        } else if output != tappedOutput {
            reason = "the Mac's output device changed"
        } else if let capture, let rate = tapSampleRate(capture.tap), rate != tappedRate {
            reason = "the call's audio format changed"
        } else if capture == nil || (stalled > 4 && (everHeard || sinceConnect > 30)) {
            // Before the first audio ever arrives, macOS may still be asking for permission: give it time.
            reason = "no audio was arriving"
        } else if everHeard, silent > silentPatience, sinceConnect > silentPatience, isPlaying(apps) {
            // The app says it is playing but we hear nothing. That is normal when nobody
            // is talking, and it is also exactly what a dead connection looks like, so
            // reconnect, but less and less often while the silence lasts.
            reason = "the call app was playing but nothing was heard"
            worthNoting = false
            silentPatience = min(silentPatience * 2, 60)
        }
        if silent < 2 { silentPatience = 8 }
        guard let reason else { return }

        // Connect anew before letting go of the old connection, so nothing is missed in
        // between. The track ignores the old one as soon as the new one delivers.
        let old = capture
        do {
            capture = try makeCapture()
            reconnects += 1
            if worthNoting { note("Reconnected to the call's audio because \(reason)") }
            if let old {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.destroy(old) }
            }
        } catch {
            lastConnect = Date()
            note("Couldn't reconnect to the call's audio (\(error)); trying again")
        }
    }

    private func tapSampleRate(_ tap: AudioObjectID) -> Double? {
        var description = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &description) == noErr ? description.mSampleRate : nil
    }

    private func isPlaying(_ processes: Set<AudioObjectID>) -> Bool {
        processes.contains { object in
            var running: UInt32 = 0
            var size = UInt32(MemoryLayout<UInt32>.size)
            var address = AudioObjectPropertyAddress(
                mSelector: kAudioProcessPropertyIsRunningOutput,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &running) == noErr && running != 0
        }
    }

    // Core Audio's handles for the running processes of the apps we want to record.
    private func audioProcesses(withBundlePrefixes prefixes: [String]) -> [AudioObjectID] {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &objects) == noErr else { return [] }

        return objects.filter { object in
            var bundle: CFString = "" as CFString
            var bundleSize = UInt32(MemoryLayout<CFString>.size)
            var bundleAddress = AudioObjectPropertyAddress(
                mSelector: kAudioProcessPropertyBundleID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            let status = withUnsafeMutablePointer(to: &bundle) {
                AudioObjectGetPropertyData(object, &bundleAddress, 0, nil, &bundleSize, $0)
            }
            let id = status == noErr ? (bundle as String).lowercased() : ""
            if !id.isEmpty { return prefixes.contains { id.hasPrefix($0.lowercased()) } }

            // Command-line players have no bundle id; match those by program name.
            var pid: pid_t = 0
            var pidSize = UInt32(MemoryLayout<pid_t>.size)
            var pidAddress = AudioObjectPropertyAddress(
                mSelector: kAudioProcessPropertyPID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            guard AudioObjectGetPropertyData(object, &pidAddress, 0, nil, &pidSize, &pid) == noErr else { return false }
            var nameBuffer = [CChar](repeating: 0, count: 256)
            guard proc_name(pid, &nameBuffer, UInt32(nameBuffer.count)) > 0 else { return false }
            let name = String(cString: nameBuffer).lowercased()
            return prefixes.contains { name == $0.lowercased() }
        }
    }

    private func defaultOutputDeviceUID() throws -> String {
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice, // where apps play, not where alerts play
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device), "Finding the output device")

        var uid: CFString = "" as CFString
        size = UInt32(MemoryLayout<CFString>.size)
        address.mSelector = kAudioDevicePropertyDeviceUID
        try withUnsafeMutablePointer(to: &uid) { pointer in
            try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, pointer), "Reading the output device")
        }
        return uid as String
    }

    // ---------- you: the default microphone ----------

    func startMicrophone() throws {
        try connectMicrophone()
        // Plugging in headphones or switching microphones stops the engine; start it again.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.engine.inputNode.removeTap(onBus: 0)
            do {
                try self.connectMicrophone()
                self.note("Reconnected to the microphone because the Mac's audio devices changed")
            } catch {
                self.note("The microphone stopped being recorded: \(error)")
            }
        }
    }

    private func connectMicrophone() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw RecorderError(description: "No microphone is available")
        }
        let track = mic
        let url = outDir.appendingPathComponent("mic.caf")
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, when in
            track.capture(buffer, hostTime: when.isHostTimeValid ? when.hostTime : 0, into: url)
        }
        engine.prepare()
        try engine.start()
    }

    // ---------- status and stopping ----------

    func setState(_ value: String) {
        lock.lock(); state = value; lock.unlock()
        writeStatus()
    }

    func writeStatus() {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let systemReport = system.status(file: "system.caf", iso: iso)
        let micReport = mic.status(file: "mic.caf", iso: iso)
        lock.lock()
        let status: [String: Any] = [
            "state": state,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "startedAt": iso.string(from: startedAt),
            "elapsedSeconds": Int(Date().timeIntervalSince(startedAt)),
            "system": systemReport,
            "mic": micReport,
            "reconnects": reconnects,
            "notes": notes,
        ]
        lock.unlock()
        if let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: outDir.appendingPathComponent("status.json"), options: .atomic)
        }
    }

    func stop() {
        stopSystemAudio()
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        system.close() // closing the files finishes them
        mic.close()
        setState("stopped")
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let recorder: Recorder
    private var statusItem: NSStatusItem?
    private var timers: [Timer] = []
    private var signals: [DispatchSourceSignal] = []
    private var stopping = false

    init(recorder: Recorder) {
        self.recorder = recorder
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "● REC 0:00"
        let menu = NSMenu()
        let header = NSMenuItem(title: "Mibbit Meeting Recorder is recording this call", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())
        let stopItem = NSMenuItem(title: "Stop recording", action: #selector(stopFromMenu), keyEquivalent: "")
        stopItem.target = self
        menu.addItem(stopItem)
        item.menu = menu
        statusItem = item

        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.finish() }
            source.resume()
            signals.append(source)
        }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async { self?.begin(microphoneAllowed: granted) }
        }
    }

    private func begin(microphoneAllowed: Bool) {
        recorder.markStarted() // the clock starts once the permission question is answered
        do {
            try recorder.startSystemAudio()
        } catch {
            recorder.note("The call's audio isn't being recorded yet: \(error)")
        }
        if microphoneAllowed {
            do {
                try recorder.startMicrophone()
            } catch {
                recorder.note("The microphone is NOT being recorded: \(error)")
            }
        } else {
            recorder.note("The microphone is NOT being recorded: permission was not given")
        }
        recorder.setState("recording")

        timers.append(Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self, !self.stopping else { return }
            self.recorder.watchSystemAudio()
            self.recorder.writeStatus()
            if FileManager.default.fileExists(atPath: self.recorder.outDir.appendingPathComponent("stop").path) {
                self.finish()
            }
        })
        timers.append(Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            let seconds = Int(Date().timeIntervalSince(self.recorder.startedAt))
            let clock = seconds >= 3600
                ? String(format: "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60)
                : String(format: "%d:%02d", seconds / 60, seconds % 60)
            self.statusItem?.button?.title = "● REC \(clock)"
        })
    }

    @objc private func stopFromMenu() {
        finish()
    }

    private func finish() {
        if stopping { return }
        stopping = true
        timers.forEach { $0.invalidate() }
        recorder.stop()
        NSApp.terminate(nil)
    }
}

let arguments = CommandLine.arguments.dropFirst()
guard let folder = arguments.first else {
    FileHandle.standardError.write(Data("Usage: open \"Mibbit Meeting Recorder.app\" --args <output-folder> [app-bundle-id-prefix ...]\n".utf8))
    exit(2)
}
let outDir = URL(fileURLWithPath: folder, isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let prefixes = arguments.dropFirst().isEmpty ? ["com.hnc.Discord"] : Array(arguments.dropFirst())
let delegate = AppDelegate(recorder: Recorder(outDir: outDir, appPrefixes: prefixes))
app.delegate = delegate
app.run()
