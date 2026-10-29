// Hanobi's speech helper: Apple speech recognition on this Mac, with no network.
// Usage: hanobi-speech <locale>          records from the microphone until "stop" or "cancel" arrives on stdin
//        hanobi-speech --status <locale>  prints the permission and on-device support, then exits
// Output: one JSON object per line: ready, level (0..1), partial (text so far), final (text), error (message).
import Foundation
import Speech
import AVFoundation

setvbuf(stdout, nil, _IOLBF, 0)
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}
func fail(_ message: String) -> Never { emit(["type": "error", "message": message]); exit(1) }

let args = CommandLine.arguments.dropFirst()
let statusOnly = args.first == "--status"
let locale = Locale(identifier: args.last(where: { !$0.hasPrefix("--") }) ?? "en-US")
guard let recognizer = SFSpeechRecognizer(locale: locale) else { fail("Speech recognition does not support \(locale.identifier).") }

let names: [SFSpeechRecognizerAuthorizationStatus: String] = [.notDetermined: "unknown", .denied: "denied", .restricted: "restricted", .authorized: "granted"]
if statusOnly {
  emit(["type": "status", "permission": names[SFSpeechRecognizer.authorizationStatus()] ?? "unknown", "onDevice": recognizer.supportsOnDeviceRecognition, "available": recognizer.isAvailable])
  exit(0)
}

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
// Audio never leaves the Mac. Languages without on-device support fail here instead of using Apple's servers.
guard recognizer.supportsOnDeviceRecognition else { fail("On-device speech recognition is not available for \(locale.identifier) on this Mac.") }
request.requiresOnDeviceRecognition = true
request.taskHint = .dictation
if #available(macOS 13, *) { request.addsPunctuation = true }

var latest = ""
var finished = false
func finish() {
  if finished { return }
  finished = true
  emit(["type": "final", "text": latest])
  exit(0)
}

func start() {
  let input = engine.inputNode
  let format = input.outputFormat(forBus: 0)
  guard format.sampleRate > 0 else { fail("No microphone is available.") }
  var lastLevel = Date.distantPast
  input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
    guard let samples = buffer.floatChannelData?[0], Date().timeIntervalSince(lastLevel) > 0.08 else { return }
    lastLevel = Date()
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
    emit(["type": "level", "value": min(1, sqrt(sum / Float(max(1, buffer.frameLength))) * 6)])
  }
  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      latest = result.bestTranscription.formattedString
      if result.isFinal { DispatchQueue.main.async { finish() } } else { emit(["type": "partial", "text": latest]) }
    } else if let error = error {
      // Silence ends the task with "no speech detected"; that is an empty result, not a failure.
      DispatchQueue.main.async { if latest.isEmpty && (error as NSError).code != 1110 { fail(error.localizedDescription) } else { finish() } }
    }
  }
  engine.prepare()
  do { try engine.start() } catch { fail("The microphone did not start: \(error.localizedDescription)") }
  emit(["type": "ready"])
}

// stdin: "stop" ends the audio and waits for the final text; "cancel" or a closed stdin (Hanobi quit) exits at once.
DispatchQueue.global().async {
  while let line = readLine() {
    if line == "stop" {
      DispatchQueue.main.async {
        engine.stop(); engine.inputNode.removeTap(onBus: 0); request.endAudio()
        // The final result usually arrives in well under a second; never wait forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { finish() }
      }
    } else if line == "cancel" { exit(0) }
  }
  exit(0)
}

SFSpeechRecognizer.requestAuthorization { status in
  DispatchQueue.main.async {
    switch status {
    case .authorized: start()
    case .denied: fail("Hanobi cannot use speech recognition. Allow it in System Settings → Privacy & Security → Speech Recognition.")
    case .restricted: fail("Speech recognition is restricted on this Mac.")
    default: fail("Speech recognition permission was not given.")
    }
  }
}
RunLoop.main.run()
