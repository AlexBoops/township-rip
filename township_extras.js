// Township-only page extras:
//  - credit line under the TOWNSHIP logo on the game's own loading screen (game font)
//  - toolbar buttons: Save (downloads the town as a .township file) and Load (replaces the
//    town with one, checks it really reached browser storage, then reloads the page)
(() => {
  'use strict';
  const CREDIT = 'Port by TS (pls @)';

  // ------------------------------------------------------------ credit on the loading screen
  const style = document.createElement('style');
  style.textContent = `
    @font-face { font-family: 'Townshipfont'; src: url('fonts/tsfont.ttf') format('truetype'); font-display: block; }
    #tw-credit { position: fixed; z-index: 4; pointer-events: none; transform: translate(-50%, 0);
      font-family: 'Townshipfont', system-ui, sans-serif; color: #fff; white-space: nowrap; letter-spacing: .02em;
      -webkit-text-stroke: .16em #6b3410; paint-order: stroke fill;
      text-shadow: 0 .09em 0 #4a2208, 0 .12em .12em rgba(40,15,0,.5);
      transition: opacity .4s; }
    #tw-credit.gone { opacity: 0; }
    #tw-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 10001;
      background: #1c2340; color: #f3f5fb; padding: 10px 16px; border-radius: 10px; max-width: calc(100vw - 32px);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
    #tw-toast.err { background: #5a1d24; }
    #tw-busy { position: fixed; inset: 0; z-index: 10002; display: flex; align-items: center; justify-content: center;
      background: rgba(10,14,30,.72); color: #f3f5fb; font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    #tw-busy div { background: #1c2340; padding: 18px 24px; border-radius: 14px; }
  `;
  document.head.appendChild(style);

  let credit = null, creditOn = false;
  function placeCredit() {
    if (!creditOn) return;
    const cv = document.getElementById('canvas');
    if (cv && credit) {
      const r = cv.getBoundingClientRect();
      // the logo banner ends about a quarter of the way down the loading screen
      credit.style.left = (r.left + r.width / 2) + 'px';
      credit.style.top = (r.top + r.height * 0.255) + 'px';
      credit.style.fontSize = Math.max(11, r.height * 0.038) + 'px';
    }
    requestAnimationFrame(placeCredit);
  }
  function showCredit() {
    if (creditOn) return;
    credit = document.createElement('div');
    credit.id = 'tw-credit';
    credit.textContent = CREDIT;
    document.body.appendChild(credit);
    creditOn = true;
    placeCredit();
  }
  function hideCredit() {
    if (!creditOn) return;
    creditOn = false;
    credit.classList.add('gone');
    const el = credit;
    setTimeout(() => el.remove(), 450);
  }
  // the game's loading screen is up from when the page loader goes away until the town shows
  const waitStart = setInterval(() => {
    if (!document.getElementById('loader')) { clearInterval(waitStart); showCredit(); }
  }, 100);

  // ------------------------------------------------------------ toast / busy
  let toastTimer = 0;
  function toast(msg, err) {
    let t = document.getElementById('tw-toast');
    if (!t) { t = document.createElement('div'); t.id = 'tw-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = err ? 'err' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), err ? 9000 : 4000);
  }
  function busy(msg) {
    let b = document.getElementById('tw-busy');
    if (msg == null) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'tw-busy'; b.appendChild(document.createElement('div')); document.body.appendChild(b); }
    b.firstChild.textContent = msg;
  }

  // ------------------------------------------------------------ Save / Load buttons
  const stamp = () => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    let h = d.getHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${h}-${p(d.getMinutes())}${ap}`;
  };
  function save() {
    try {
      if (!window.SaveGuard || !SaveGuard.ready) throw new Error('the game has not started yet');
      const text = SaveGuard.exportSave();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
      a.download = `township_${stamp()}.township`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast('Town saved to your downloads.');
    } catch (e) { toast('Could not save: ' + e.message, true); }
  }
  function load() {
    if (!window.SaveGuard || !SaveGuard.ready) { toast('Wait for the game to start, then load the save.', true); return; }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.township';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (!confirm(`Load "${f.name}"?\n\nThis replaces the town that's in this browser now (a backup of it is kept). The page reloads afterwards.`)) return;
      window.TW_HOLD = true;                 // pause the game so it can't write while we swap
      try {
        const n = await SaveGuard.importSave(await f.text(), msg => busy(msg));
        busy(`Save loaded and checked (${n} files). Reloading…`);
        // nothing may touch the saved files any more before the reload
        if (window.M && M.FS) M.FS.syncfs = (a, b) => { const cb = typeof a === 'function' ? a : b; if (cb) cb(null); };
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        busy(null);
        window.TW_HOLD = false;
        toast('Load failed: ' + e.message + ' (your previous town was backed up first)', true);
      }
    };
    inp.click();
  }
  window.addEventListener('tw-save-loaded', e => {
    if (e.detail.ok) toast('Save loaded and verified.');
    else toast('Warning: the loaded save does not match the file. Open the log for details.', true);
  });

  function addButtons() {
    const tools = document.getElementById('tools'), sound = document.getElementById('bSound');
    if (!tools || !sound) return;
    const mk = (id, title, svg, fn) => {
      const b = document.createElement('button');
      b.id = id; b.title = title; b.setAttribute('aria-label', title);
      b.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg>`;
      b.onclick = fn;
      return b;
    };
    const bSave = mk('bSave', 'Save town to a file', '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', save);
    const bLoad = mk('bLoad', 'Load town from a file', '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>', load);
    sound.after(bSave, bLoad);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButtons);
  else addButtons();

  window.TWExtras = { showCredit, hideCredit, save, load };
})();
