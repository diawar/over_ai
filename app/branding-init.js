// Runs in <head>, before the stylesheet and the first paint.
(() => {
  const id = Number(new URLSearchParams(location.search).get('organization_id') || 1);
  const organizationId = Number.isSafeInteger(id) && id > 0 ? id : 1;
  const key = `corelab:brand-color:${organizationId}`;
  const root = document.documentElement;
  function apply(color, remember = true) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    const rgb = color.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    root.style.setProperty('--accent', color);
    root.style.setProperty('--on-accent', rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? '#171717' : '#ffffff');
    if (remember) { try { localStorage.setItem(key, color); } catch { /* optional */ } }
    return true;
  }
  let cached = false;
  try {
    const color = localStorage.getItem(key);
    // The old default must be revalidated after the e2e default-color migration.
    cached = color?.toLowerCase() !== '#5146e5' && apply(color, false);
  } catch { /* optional */ }
  root.classList.toggle('brand-pending', !cached);
  const ready = () => root.classList.remove('brand-pending');
  const timeout = setTimeout(ready, 6000);
  globalThis.corelabTheme = { apply, ready: () => { clearTimeout(timeout); ready(); } };
  window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue, false); });
})();
