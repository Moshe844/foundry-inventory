'use strict';
// Address boxes (partials/address-fields.ejs): state/province by country, city
// and state from a ZIP or postal code, and, for forms that store one line,
// keeping that line and the boxes in step both ways.
(() => {
  if (window.stockChiefAddressFields) return;
  window.stockChiefAddressFields = true;
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const lookups = new Map();
  const lookup = (country, code) => {
    const key = country + ':' + code;
    if (!lookups.has(key)) lookups.set(key, fetch('/address/postal?country=' + encodeURIComponent(country) + '&code=' + encodeURIComponent(code),
      { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : { places: [] })).catch(() => ({ places: [] })));
    return lookups.get(key);
  };
  document.querySelectorAll('[data-address-box]').forEach((box) => {
    const part = (name) => box.querySelector('[data-part="' + name + '"]');
    const regions = JSON.parse(box.dataset.regions || '{}');
    const target = box.dataset.addressTarget ? document.getElementById(box.dataset.addressTarget) : null;
    const country = part('country'), state = part('state'), stateText = part('stateText'), zip = part('postalCode'), city = part('city');
    const list = box.querySelector('datalist'), note = box.querySelector('[data-postal-note]');
    let auto = { city: false, state: false };
    const stateValue = () => (state.disabled ? stateText.value.trim() : state.value);
    function useRegions(code, keep) {
      const options = regions[code], name = state.getAttribute('name') || stateText.getAttribute('name');
      box.querySelector('[data-state-label]').textContent = code === 'CA' ? 'Province' : code === 'US' ? 'State' : 'State or region';
      box.querySelector('[data-zip-label]').textContent = code === 'US' ? 'ZIP code' : 'Postal code';
      if (options) {
        state.replaceChildren(new Option('Choose…', ''), ...options.map(([value, label]) => new Option(label, value)));
        const wanted = String(keep || '').trim().toLowerCase(), hit = options.find(([value, label]) => value.toLowerCase() === wanted || label.toLowerCase() === wanted);
        state.value = hit ? hit[0] : '';
      } else if (keep !== undefined) stateText.value = keep || '';
      state.hidden = state.disabled = !options; stateText.hidden = stateText.disabled = Boolean(options);
      if (name) { state.removeAttribute('name'); stateText.removeAttribute('name'); (options ? state : stateText).setAttribute('name', name); }
    }
    function compose() {
      const line = [part('line1').value, part('line2').value, city.value, [stateValue(), zip.value.trim()].filter(Boolean).join(' ')]
        .map((v) => String(v || '').trim()).filter(Boolean).join(', ');
      return line && country.value !== 'US' ? line + ', ' + country.value : line;
    }
    function write() {
      if (!target) return;
      nativeValue.set.call(target, compose());
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function read(text) {
      const parts = String(text || '').split(/\s*[,\n]\s*/).map((v) => v.trim()).filter(Boolean);
      let code = 'US';
      // A last part naming the country, as a code ("US") or by name ("United States", "USA").
      const named = (name) => {
        const wanted = name.toLowerCase().replace(/\./g, '');
        if (['usa', 'united states of america'].includes(wanted)) return 'US';
        const hit = [...country.options].find((o) => (/^[a-z]{2}$/.test(wanted) && o.value.toLowerCase() === wanted) || o.text.toLowerCase() === wanted);
        return hit ? hit.value : '';
      };
      if (parts.length > 1 && named(parts[parts.length - 1])) code = named(parts.pop());
      else if (parts.length === 1 && /\s(USA|U\.S\.A\.?|United States(?: of America)?)$/i.test(parts[0])) parts[0] = parts[0].replace(/\s(USA|U\.S\.A\.?|United States(?: of America)?)$/i, '').trim();
      let st = '', pc = '', last = parts.length ? parts[parts.length - 1] : '';
      // US and Canadian lines often arrive without commas: "18 Forshay Rd Monsey NY 10952".
      const postal = /(?:^|\s)(\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d)$/.exec(last);
      if (postal && (code === 'US' || code === 'CA')) {
        pc = postal[1].toUpperCase(); last = last.slice(0, postal.index).trim();
        if (/^[A-Z]/.test(pc)) code = 'CA';
        let best = '';
        (regions[code] || []).forEach(([value, label]) => [value, label].forEach((name) => {
          const lower = last.toLowerCase(), wanted = name.toLowerCase();
          if ((lower === wanted || lower.endsWith(' ' + wanted)) && name.length > best.length) { best = name; st = value; }
        }));
        last = last.slice(0, last.length - best.length).trim();
        if (last) parts[parts.length - 1] = last; else parts.pop();
      } else {
        const tail = parts.length > 1 ? /^(.*?)\s+([A-Za-z0-9][A-Za-z0-9 -]{2,9})$/.exec(last) : null;
        // "London SW1A 2AA": with no states or provinces to choose from, the words are the town.
        if (tail && /\d/.test(tail[2])) { pc = tail[2]; if (regions[code]) { st = tail[1]; parts.pop(); } else parts[parts.length - 1] = tail[1]; }
        else if (parts.length > 2 && /^[A-Za-z .]{2,}$/.test(last)) st = parts.pop();
      }
      const town = parts.length > 1 ? parts.pop() : '';
      country.value = code; shownCountry = code; useRegions(code, st);
      part('line1').value = parts.shift() || ''; part('line2').value = parts.join(', '); city.value = town; zip.value = pc;
      if (pc && !town && part('line1').value) splitTown(code, pc, part('line1').value);
    }
    // Street and town ran together: the postal code says which town, so take it off the end.
    async function splitTown(code, pc, street) {
      const found = (await lookup(code, code === 'US' ? pc.slice(0, 5) : pc.slice(0, 3))).places || [];
      if (part('line1').value !== street || city.value || !found.length) return;
      const lower = street.toLowerCase(), hit = found.find((p) => lower.endsWith(' ' + p.city.toLowerCase()));
      if (!hit && found.length > 1) return;
      if (hit) part('line1').value = street.slice(0, street.length - hit.city.length).replace(/[\s,]+$/, '');
      city.value = (hit || found[0]).city; auto.city = !hit;
      if (!stateValue() && found[0].state) useRegions(code, found[0].state);
    }
    async function fillFromPostal() {
      const code = zip.value.trim().toUpperCase(), c = country.value;
      if (!(c === 'US' && /^\d{5}$/.test(code.slice(0, 5))) && !(c === 'CA' && /^[A-Z]\d[A-Z]/.test(code))) return;
      const found = (await lookup(c, c === 'US' ? code.slice(0, 5) : code.slice(0, 3))).places || [];
      if (zip.value.trim().toUpperCase() !== code || !found.length) return;
      list.replaceChildren(...found.map((p) => new Option(p.city, p.city)));
      if (!city.value.trim() || auto.city) { city.value = found[0].city; auto.city = true; }
      if (found[0].state && (!stateValue() || auto.state)) { useRegions(c, found[0].state); auto.state = true; }
      note.hidden = found.length < 2;
      note.textContent = found.length > 1 ? found.length + ' towns use ' + code + '. Pick the right one in City.' : '';
      write();
    }
    // Only a different country clears the state; re-choosing the same one keeps it.
    let shownCountry = country.value;
    country.addEventListener('change', () => { if (country.value !== shownCountry) useRegions(country.value, ''); shownCountry = country.value; write(); });
    city.addEventListener('input', () => { auto.city = false; });
    state.addEventListener('change', () => { auto.state = false; });
    zip.addEventListener('input', () => { fillFromPostal(); });
    box.addEventListener('input', (event) => { if (event.target !== target) write(); });
    box.addEventListener('change', (event) => { if (event.target !== target) write(); });
    if (target) {
      // Other scripts fill the stored line (choosing a saved customer); show it in the boxes.
      Object.defineProperty(target, 'value', { configurable: true, get() { return nativeValue.get.call(this); },
        set(value) { nativeValue.set.call(this, value); read(value); } });
      if (nativeValue.get.call(target).trim()) read(nativeValue.get.call(target));
      const required = () => ['line1', 'city', 'postalCode'].forEach((name) => { part(name).required = target.required; });
      new MutationObserver(required).observe(target, { attributes: true, attributeFilter: ['required'] }); required();
    }
  });
})();
