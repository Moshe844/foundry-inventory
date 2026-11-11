'use strict';
// Ask StockChief: find a conversation, speak a question, drop in a file, and a box that grows.
(function () {
  var filter = document.querySelector('[data-chat-filter]');
  if (filter) filter.addEventListener('input', function () {
    var term = filter.value.trim().toLowerCase(), any = false;
    document.querySelectorAll('[data-chat-group]').forEach(function (group) {
      var visible = false;
      group.querySelectorAll('[data-chat-row]').forEach(function (row) { var match = !term || row.dataset.chatText.includes(term); row.hidden = !match; visible = visible || match; });
      group.hidden = !visible; any = any || visible;
    });
    var none = document.querySelector('[data-chat-none]'); if (none) none.hidden = any;
  });
  // Only one conversation menu open at a time, and a click elsewhere closes it.
  document.addEventListener('click', function (event) {
    document.querySelectorAll('.ask-menu[open]').forEach(function (menu) { if (!menu.contains(event.target)) menu.open = false; });
  });
  var form = document.querySelector('[data-chat-composer]'), box = form && form.querySelector('[data-ask-input]');
  if (!form || !box) return;
  // A suggestion or Ask again goes to the conversation on screen, not whichever another tab opened last.
  document.addEventListener('submit', function (event) {
    if (!event.target.classList.contains('ask-send')) return;
    ['chatId', 'chatContext'].forEach(function (name) {
      var from = form.querySelector('[name=' + name + ']');
      if (!from || event.target.querySelector('[name=' + name + ']')) return;
      var copy = document.createElement('input'); copy.type = 'hidden'; copy.name = name; copy.value = from.value; event.target.appendChild(copy);
    });
  }, true);
  function grow() { box.style.height = 'auto'; box.style.height = Math.min(220, box.scrollHeight + 2) + 'px'; }
  box.addEventListener('input', grow); if (box.value) grow();
  // A file dropped anywhere on the box is attached the same way as the Attach button.
  var file = form.querySelector('input[type=file]');
  if (file && window.DataTransfer) {
    ['dragenter', 'dragover'].forEach(function (name) { form.addEventListener(name, function (event) { if (event.dataTransfer && Array.prototype.includes.call(event.dataTransfer.types, 'Files')) { event.preventDefault(); form.classList.add('is-dropping'); } }); });
    ['dragleave', 'drop'].forEach(function (name) { form.addEventListener(name, function () { form.classList.remove('is-dropping'); }); });
    form.addEventListener('drop', function (event) {
      var dropped = event.dataTransfer && event.dataTransfer.files;
      if (!dropped || !dropped.length) return;
      event.preventDefault();
      var list = new DataTransfer(); list.items.add(dropped[0]); file.files = list.files;
      file.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  // Two ways to talk instead of typing. Speak: the browser types the words as
  // you talk. Voice note: a recording in any language (Yiddish, English, Hebrew
  // and others), read into text by StockChief and placed in the box to check
  // before sending.
  var Speech = window.SpeechRecognition || window.webkitSpeechRecognition, voice = form.querySelector('[data-voice-input]');
  var note = form.querySelector('[data-voice-note]');
  var voiceStatus = form.querySelector('[data-voice-status]');
  var noteRecorder = window.StockChiefVoiceNote;
  if (note && noteRecorder && noteRecorder.supported()) {
    note.hidden = false;
    var noteLabel = note.querySelector('span'), active = null, ready = note.getAttribute('data-voice-note-ready') === '1';
    var tell = function (text) { if (voiceStatus) { voiceStatus.textContent = text || ''; voiceStatus.hidden = !text; } };
    var idle = function () { active = null; note.disabled = false; note.setAttribute('aria-pressed', 'false'); noteLabel.textContent = 'Voice note'; };
    var read = function (file) {
      note.disabled = true; noteLabel.textContent = 'Reading…'; tell('Reading your voice note…');
      var data = new FormData(), csrf = form.querySelector('input[name=_csrf]');
      data.append('_csrf', csrf ? csrf.value : '');
      data.append('usageKey', 'voice-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      data.append('recording', file);
      return fetch('/ask/voice', { method: 'POST', body: data, credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            if (!response.ok || typeof body.text !== 'string') throw new Error((body.error && body.error.message) || 'The voice note could not be read. Try again or type the question.');
            return body;
          });
        })
        .then(function (body) {
          var start = box.value ? box.value.replace(/\s*$/, ' ') : '';
          box.value = (start + body.text).slice(0, box.maxLength > 0 ? box.maxLength : 2000); grow(); box.focus();
          tell(body.truncated ? 'Only the first 2,000 characters fit in the box. Check the words, then send.' : 'Check the words, then send.');
        })
        .catch(function (error) { tell(error.message); })
        .then(idle);
    };
    note.addEventListener('click', function () {
      // Without the transcription service the button stays, and says why it cannot record yet.
      if (!ready) { tell('Voice notes are not switched on for this StockChief yet. Use Speak, or type the question.'); return; }
      if (active) { var current = active; active = null; current.stop().then(read, function (error) { tell(error.message); idle(); }); return; }
      note.disabled = true;
      noteRecorder.start().then(function (recording) {
        active = recording; note.disabled = false; note.setAttribute('aria-pressed', 'true'); noteLabel.textContent = 'Stop';
        tell('Recording. Speak in any language, then press Stop. Up to two minutes.');
        // At two minutes the recording stops by itself and is read.
        recording.done.then(function (file) { if (active === recording) { active = null; read(file); } }, function (error) { if (active === recording) { tell(error.message); idle(); } });
      }, function () { idle(); tell('The microphone is not available. Allow it in the browser, or type the question.'); });
    });
  }
  if (Speech && voice) {
    voice.hidden = false;
    var listening = null, label = voice.querySelector('span');
    voice.addEventListener('click', function () {
      if (listening) { listening.stop(); return; }
      var start = box.value ? box.value.replace(/\s*$/, ' ') : '';
      listening = new Speech(); listening.interimResults = true; listening.lang = document.documentElement.lang || 'en-US';
      listening.onresult = function (event) { box.value = start + Array.prototype.map.call(event.results, function (result) { return result[0].transcript; }).join(''); grow(); };
      listening.onend = function () { listening = null; voice.setAttribute('aria-pressed', 'false'); label.textContent = 'Speak'; box.focus(); };
      voice.setAttribute('aria-pressed', 'true'); label.textContent = 'Listening…';
      listening.start();
    });
  }
})();

// Every table in a written answer can be saved, in the format the person needs.
(function () {
  var enhance = function () {
    document.querySelectorAll('[data-adaptive-goal][data-goal-status="COMPLETED"]').forEach(function (goal) {
      var answer = goal.querySelector('[data-goal-answer]');
      if (!answer || !answer.textContent.trim()) return;
      function addDownload(target, query, label) {
        if (target.previousElementSibling && target.previousElementSibling.matches('.ask-download')) return;
        var menu = document.createElement('details');
        menu.className = query==='?content=answer'?'ask-download':'ask-download ask-download--inline';
        var summary = document.createElement('summary');
        summary.textContent = label;
        var list = document.createElement('div');
        list.className = 'ask-download__menu';
        [['PDF', 'pdf'], ['Excel', 'xlsx'], ['CSV', 'csv']].forEach(function (entry) {
          var link = document.createElement('a');
          link.textContent = entry[0];
          link.setAttribute('download', '');
          link.href = '/ask/goals/' + encodeURIComponent(goal.getAttribute('data-adaptive-goal')) + '/export.' + entry[1] + query;
          list.appendChild(link);
        });
        menu.appendChild(summary);
        menu.appendChild(list);
        target.parentNode.insertBefore(menu, target);
      }
      // Only an answer worth keeping offers a download: a table, or a written
      // report of 400 characters or more (the same rule as ask-export.js).
      if (answer.querySelector('table') || answer.textContent.trim().length >= 400) addDownload(answer, '?content=answer', 'Download answer');
      answer.querySelectorAll('.rm-agent__table').forEach(function (table, index) {
        addDownload(table, '?table=' + index, 'Download');
      });
    });
  };
  enhance();
  var scroll = document.querySelector('[data-chat-scroll]');
  if (scroll && window.MutationObserver) new MutationObserver(enhance).observe(scroll, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-goal-status'] });
  document.addEventListener('click', function (event) {
    document.querySelectorAll('.ask-download[open]').forEach(function (open) { if (!open.contains(event.target)) open.open = false; });
  });
  // A menu opens downward unless the box that scrolls or clips it ends first;
  // then it opens upward, so every format can be seen and chosen.
  document.addEventListener('toggle', function (event) {
    var menu = event.target;
    if (!menu.classList || !menu.classList.contains('ask-download')) return;
    menu.classList.remove('ask-download--up');
    var list = menu.querySelector('.ask-download__menu');
    if (!menu.open || !list) return;
    var top = 0, bottom = window.innerHeight;
    for (var box = menu.parentElement; box && box !== document.body; box = box.parentElement) {
      if (getComputedStyle(box).overflowY === 'visible') continue;
      var edge = box.getBoundingClientRect(); top = Math.max(top, edge.top); bottom = Math.min(bottom, edge.bottom);
    }
    var place = menu.getBoundingClientRect(), room = list.offsetHeight + 8;
    if (place.bottom + room > bottom && place.top - room >= top) menu.classList.add('ask-download--up');
  }, true);
}());
