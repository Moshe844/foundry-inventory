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
  // Speaking, where the browser can do it. The words land in the box to check before sending.
  var Speech = window.SpeechRecognition || window.webkitSpeechRecognition, voice = form.querySelector('[data-voice-input]');
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
      addDownload(answer, '?content=answer', 'Download answer');
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
}());
