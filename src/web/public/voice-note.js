'use strict';
// Records a voice note and hands it back as the mono 16 kHz WAV the server
// reads (documents/voice-wave.js): two minutes at most, stopped automatically.
(function () {
  var rate = 16000, maximumSeconds = 120;
  function supported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.AudioContext && window.OfflineAudioContext);
  }
  async function toWav(recording) {
    var context = new AudioContext();
    try {
      var decoded = await context.decodeAudioData(await recording.arrayBuffer());
      var frames = Math.min(rate * maximumSeconds, Math.floor(decoded.duration * rate));
      if (frames < rate / 4) throw new Error('That voice note was too short. Hold the button a little longer.');
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
  // Starts recording. stop() ends it early; done resolves with the WAV either way.
  async function start() {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var recorder = new MediaRecorder(stream), chunks = [];
    recorder.addEventListener('dataavailable', function (event) { if (event.data.size) chunks.push(event.data); });
    var release = function () { stream.getTracks().forEach(function (track) { track.stop(); }); };
    var finished = new Promise(function (resolve, reject) {
      recorder.addEventListener('stop', function () { release(); resolve(new Blob(chunks, { type: recorder.mimeType })); });
      recorder.addEventListener('error', function () { release(); reject(new Error('The recording stopped. Try again.')); });
    });
    var done = finished.then(toWav);
    recorder.start();
    var timer = setTimeout(function () { if (recorder.state === 'recording') recorder.stop(); }, maximumSeconds * 1000);
    return { done: done, stop: function () { clearTimeout(timer); if (recorder.state === 'recording') recorder.stop(); return done; } };
  }
  window.StockChiefVoiceNote = { supported: supported, start: start, maximumSeconds: maximumSeconds };
}());
