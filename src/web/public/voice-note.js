'use strict';
// Records a voice note and hands it back as the mono 16 kHz WAV the server
// reads (documents/voice-wave.js). It listens while recording: once the person
// has spoken and then stays quiet for a moment, it stops by itself. If nothing
// is said at all, it stops and reports that no speech was heard, so a silent
// recording is never sent. Two minutes at most.
(function () {
  var rate = 16000, maximumSeconds = 120;
  var QUIET_AFTER_SPEECH_MS = 1600, NOTHING_SAID_MS = 8000, CALIBRATE_MS = 300;
  function supported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.AudioContext && window.OfflineAudioContext);
  }
  async function toWav(recording) {
    var context = new AudioContext();
    try {
      var decoded = await context.decodeAudioData(await recording.arrayBuffer());
      var frames = Math.min(rate * maximumSeconds, Math.floor(decoded.duration * rate));
      if (frames < rate / 4) throw new Error('That voice note was too short. Try again.');
      var offline = new OfflineAudioContext(1, frames, rate), source = offline.createBufferSource();
      source.buffer = decoded; source.connect(offline.destination); source.start();
      var samples = (await offline.startRendering()).getChannelData(0);
      var bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
      var label = function (at, value) { for (var i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
      label(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true);
      label(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      label(36, 'data'); view.setUint32(40, samples.length * 2, true);
      for (var i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
      return new File([bytes], 'Voice note.wav', { type: 'audio/wav' });
    } finally { await context.close(); }
  }
  // Starts recording. stop() ends it early. done resolves with {file, heard}:
  // heard is false when no speech was detected (the file is then null).
  async function start(options) {
    options = options || {};
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    var recorder = new MediaRecorder(stream), chunks = [], heardSpeech = false;
    var meter = new AudioContext(), analyser = meter.createAnalyser(), levels = new Float32Array(2048);
    analyser.fftSize = 2048; meter.createMediaStreamSource(stream).connect(analyser);
    recorder.addEventListener('dataavailable', function (event) { if (event.data.size) chunks.push(event.data); });
    var release = function () { clearInterval(listening); clearTimeout(timer); stream.getTracks().forEach(function (track) { track.stop(); }); meter.close().catch(function () {}); };
    var finished = new Promise(function (resolve, reject) {
      recorder.addEventListener('stop', function () { release(); resolve(new Blob(chunks, { type: recorder.mimeType })); });
      recorder.addEventListener('error', function () { release(); reject(new Error('The recording stopped. Try again.')); });
    });
    var done = finished.then(function (blob) { return heardSpeech ? toWav(blob).then(function (file) { return { file: file, heard: true }; }) : { file: null, heard: false }; });
    var stop = function () { if (recorder.state === 'recording') recorder.stop(); };
    // Listening: the room's own noise is measured first, then speech is anything clearly louder.
    var began = Date.now(), floor = 0, samples = 0, lastSpeech = 0;
    var listening = setInterval(function () {
      analyser.getFloatTimeDomainData(levels);
      var sum = 0; for (var i = 0; i < levels.length; i++) sum += levels[i] * levels[i];
      var level = Math.sqrt(sum / levels.length), now = Date.now();
      if (now - began < CALIBRATE_MS) { floor = (floor * samples + level) / (samples + 1); samples++; return; }
      if (level > Math.max(floor * 3, 0.015)) { heardSpeech = true; lastSpeech = now; if (options.onSpeech) options.onSpeech(); }
      if (heardSpeech && now - lastSpeech > QUIET_AFTER_SPEECH_MS) stop();
      if (!heardSpeech && now - began > NOTHING_SAID_MS) stop();
    }, 100);
    recorder.start();
    var timer = setTimeout(stop, maximumSeconds * 1000);
    return { done: done, stop: function () { stop(); return done; } };
  }
  window.StockChiefVoiceNote = { supported: supported, start: start, maximumSeconds: maximumSeconds };
}());
