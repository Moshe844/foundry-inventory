(() => {
  'use strict';
  for (const panel of document.querySelectorAll('[data-async-operation]')) {
    if (panel.dataset.following) continue;
    const status = new URL(panel.dataset.statusUrl, location.href), resume = new URL(panel.dataset.resumeUrl, location.href);
    if (status.origin !== location.origin || resume.origin !== location.origin) continue;
    panel.dataset.following = 'true';
    const message = panel.querySelector('[data-operation-update]');
    let dirty = false, stopped = false, failures = 0;
    for (const type of ['input', 'change']) document.addEventListener(type, event => { if (event.isTrusted) dirty = true; }, true);
    const poll = async () => {
      if (stopped) return;
      if (document.hidden) { setTimeout(poll, 2000); return; }
      try {
        const response = await fetch(status.href, { headers: { accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok) throw new Error('Status unavailable');
        const result = await response.json(); failures = 0;
        if (['COMPLETED', 'FAILED', 'REVIEW'].includes(result.state)) {
          stopped = true;
          if (!dirty) {
            if (location.pathname === resume.pathname && location.search === resume.search) {
              history.replaceState(null, '', resume.href);
              location.reload();
            } else location.replace(resume.href);
            return;
          }
          if (message) { message.textContent = result.state === 'COMPLETED' ? 'Your result is ready. ' : 'Your saved request needs attention. ';
            const link = document.createElement('a'); link.href = resume.href; link.textContent = 'View saved result'; message.append(link); }
          return;
        }
        const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(result.startedAt)) / 1000));
        if (message) message.textContent = Number.isFinite(seconds) ? 'Still working · ' + seconds + ' seconds elapsed.' : 'Still working. You can leave this page and return to the saved request.';
      } catch {
        failures++;
        if (message) message.textContent = 'Connection interrupted. Your request is saved; checking again shortly.';
      }
      setTimeout(poll, Math.min(20000, 2000 * 2 ** Math.min(failures, 3)));
    };
    setTimeout(poll, 1000);
  }
})();
