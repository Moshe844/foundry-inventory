'use strict';

// The fixture advances the server's business date while Chromium's network
// cookie jar still uses the host date. Reuse only the signed session cookie
// issued by the real login response so browser requests reach the same server
// authentication and authorization checks. No session is invented or extended
// in the application, and all other request headers are untouched.
async function installBrowserBusinessClock(context, at) {
  await context.clock.install({ time:new Date(at) });
  let signedCookie = null;
  let signedIn = false;
  const pending = new Set();
  context.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/login'
      || response.request().method() !== 'GET' || signedIn) return;
    const task = (async () => {
      const header = (await response.allHeaders())['set-cookie'] || '';
      const match = /(?:^|,\s*)foundry\.sid=([^;]+)/i.exec(header);
      if (match) signedCookie = `foundry.sid=${match[1]}`;
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  await context.route(/^http:\/\/127\.0\.0\.1:\d+\//, async (route) => {
    if (!signedCookie) return route.continue();
    const headers = route.request().headers();
    const otherCookies = (headers.cookie || '').split(';').map((part) => part.trim())
      .filter((part) => part && !/^foundry\.sid=/i.test(part));
    headers.cookie = [signedCookie, ...otherCookies].join('; ');
    // Playwright does not permit overriding Cookie via route.continue.
    // Fetch this exact request with the real signed cookie, preserving the
    // method, body and redirect for Chromium's rendered UI.
    const response = await route.fetch({ headers, maxRedirects:0 });
    if (new URL(route.request().url()).pathname === '/login'
      && route.request().method() === 'POST' && response.status() >= 300
      && response.status() < 400) {
      const match = /(?:^|,\s*)foundry\.sid=([^;]+)/i.exec(response.headers()['set-cookie'] || '');
      if (match) {
        signedCookie = `foundry.sid=${match[1]}`;
        signedIn = true;
      }
    }
    const responseHeaders = response.headers();
    if (responseHeaders['set-cookie'] && /foundry\.sid=/i.test(responseHeaders['set-cookie'])) {
      const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toUTCString();
      responseHeaders['set-cookie'] = responseHeaders['set-cookie']
        .replace(/Expires=[^;]*/i, `Expires=${expires}`);
    }
    return route.fulfill({ response, headers:responseHeaders });
  });
  return { async settle() { await Promise.all([...pending]); } };
}

module.exports = { installBrowserBusinessClock };
