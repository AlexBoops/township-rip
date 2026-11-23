// On-screen keyboard, Android style: slides up from the bottom when the game asks for text
// input (KeyboardManager.toggleKeyboard), edits a text field the game owns, and reports every
// change back. A physical keyboard types into it too while it is open.
//
//   OSK.open({text, selStart, selEnd}), OSK.close(), OSK.setText(text, selStart, selEnd)
//   OSK.onChange = (text, selStart, selEnd) => ...   every edit
//   OSK.onEnter = () => ...                          the Enter / Done key
//   OSK.onHide = () => ...                           closed by the player
(() => {
  'use strict';
  const css = `
  #osk { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; transform: translateY(105%);
    transition: transform .18s ease-out; background: #1f2126; padding: 6px 4px 8px; user-select: none;
    -webkit-user-select: none; touch-action: manipulation; font: 500 18px system-ui, -apple-system, Roboto, sans-serif;
    box-shadow: 0 -4px 18px rgba(0,0,0,.35); }
  #osk.open { transform: none; }
  #osk .bar { display: flex; align-items: center; gap: 8px; margin: 0 4px 6px; }
  #osk .field { flex: 1; min-height: 36px; background: #2d3037; color: #f1f1f4; border-radius: 8px; padding: 6px 10px;
    font: 17px system-ui, sans-serif; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
  #osk .field .caret { display: inline-block; width: 2px; height: 1.1em; background: #8ab4f8; vertical-align: text-bottom;
    animation: oskblink 1s steps(1) infinite; }
  @keyframes oskblink { 50% { opacity: 0; } }
  #osk .hide { background: none; border: 0; color: #c7c9d1; font-size: 22px; width: 40px; height: 36px; cursor: pointer; }
  #osk .row { display: flex; justify-content: center; gap: 5px; margin: 5px 2px; }
  #osk .k { flex: 1 1 0; max-width: 68px; height: 46px; border: 0; border-radius: 7px; background: #3b3e46; color: #f3f3f6;
    font: inherit; cursor: pointer; box-shadow: 0 1px 0 rgba(0,0,0,.4); }
  #osk .k:active, #osk .k.down { background: #5a5e69; }
  #osk .k.wide { flex-grow: 1.6; max-width: 104px; background: #2c2f36; font-size: 15px; }
  #osk .k.space { flex-grow: 5; max-width: 360px; }
  #osk .k.go { background: #8ab4f8; color: #10213f; }
  #osk .k.on { background: #8ab4f8; color: #10213f; }
  `;
  const LAYOUTS = {
    abc: [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
          ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'], ['?123', ',', ' ', '.', '⏎']],
    sym: [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['@', '#', '$', '_', '&', '-', '+', '(', ')', '/'],
          ['=\\<', '*', '"', "'", ':', ';', '!', '?', '⌫'], ['ABC', ',', ' ', '.', '⏎']],
    sym2: [['~', '`', '|', '•', '√', 'π', '÷', '×', '¶', '∆'], ['£', '€', '¥', '^', '°', '=', '{', '}', '\\', '%'],
           ['?123', '©', '®', '™', '✓', '[', ']', '<', '>', '⌫'], ['ABC', ',', ' ', '.', '⏎']],
  };
  let root = null, fieldEl = null, rowsEl = null;
  let text = '', caret = 0, shift = 0, layout = 'abc', isOpen = false;   // shift: 0 off, 1 once, 2 caps lock

  function build() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'osk';
    const bar = document.createElement('div'); bar.className = 'bar';
    fieldEl = document.createElement('div'); fieldEl.className = 'field';
    const hide = document.createElement('button'); hide.className = 'hide'; hide.textContent = '⌄'; hide.title = 'Hide keyboard';
    hide.onpointerdown = e => { e.preventDefault(); OSK.close(true); };
    bar.append(fieldEl, hide);
    rowsEl = document.createElement('div');
    root.append(bar, rowsEl);
    root.addEventListener('pointerdown', e => e.preventDefault());   // keep focus/clicks off the game
    document.body.appendChild(root);
    render();
  }
  function label(k) {
    if (k === ' ') return 'space';
    if (k.length === 1 && layout === 'abc' && shift) return k.toUpperCase();
    return k;
  }
  function render() {
    rowsEl.textContent = '';
    for (const row of LAYOUTS[layout]) {
      const r = document.createElement('div'); r.className = 'row';
      for (const k of row) {
        const b = document.createElement('button'); b.className = 'k'; b.textContent = label(k);
        if (['⇧', '⌫', '?123', 'ABC', '=\\<', '⏎'].includes(k)) b.classList.add('wide');
        if (k === ' ') b.classList.add('space');
        if (k === '⏎') b.classList.add('go');
        if (k === '⇧' && shift) b.classList.add('on');
        b.onpointerdown = e => { e.preventDefault(); press(k); };
        r.appendChild(b);
      }
      rowsEl.appendChild(r);
    }
    paintField();
  }
  function paintField() {
    if (!fieldEl) return;
    fieldEl.textContent = '';
    fieldEl.append(document.createTextNode(text.slice(0, caret)));
    const c = document.createElement('span'); c.className = 'caret'; fieldEl.append(c);
    fieldEl.append(document.createTextNode(text.slice(caret)));
  }
  function changed() { paintField(); if (OSK.onChange) OSK.onChange(text, caret, caret); }
  function insert(s) { text = text.slice(0, caret) + s + text.slice(caret); caret += s.length; changed(); }
  function backspace() { if (caret > 0) { text = text.slice(0, caret - 1) + text.slice(caret); caret--; changed(); } }
  function press(k) {
    if (k === '⇧') { shift = shift === 0 ? 1 : shift === 1 ? 2 : 0; render(); return; }
    if (k === '⌫') { backspace(); return; }
    if (k === '?123') { layout = 'sym'; render(); return; }
    if (k === 'ABC') { layout = 'abc'; render(); return; }
    if (k === '=\\<') { layout = 'sym2'; render(); return; }
    if (k === '⏎') { if (OSK.onEnter) OSK.onEnter(); return; }
    insert(label(k) === 'space' ? ' ' : label(k));
    if (shift === 1 && layout === 'abc') { shift = 0; render(); }
  }
  // physical keyboard while open
  addEventListener('keydown', e => {
    if (!isOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Backspace') { backspace(); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === 'Enter') { if (OSK.onEnter) OSK.onEnter(); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === 'Escape') { OSK.close(true); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === 'ArrowLeft') { caret = Math.max(0, caret - 1); paintField(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { caret = Math.min(text.length, caret + 1); paintField(); e.preventDefault(); }
    else if (e.key.length === 1) { insert(e.key); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  addEventListener('paste', e => {
    if (!isOpen) return;
    const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (t) { insert(t.replace(/[\r\n]+/g, ' ')); e.preventDefault(); }
  });

  const OSK = {
    onChange: null, onEnter: null, onHide: null,
    get isOpen() { return isOpen; },
    open(o = {}) {
      if (!root) build();
      if (o.text !== undefined) { text = String(o.text); caret = Math.min(text.length, o.selEnd ?? text.length); }
      layout = 'abc'; shift = text.length ? 0 : 1; render();
      isOpen = true; root.classList.add('open');
    },
    close(byPlayer) {
      if (!root || !isOpen) return;
      isOpen = false; root.classList.remove('open');
      if (byPlayer && OSK.onHide) OSK.onHide();
    },
    setText(t, s, e) { text = String(t ?? ''); caret = Math.max(0, Math.min(text.length, e ?? s ?? text.length)); paintField(); },
    height() { return root && isOpen ? root.getBoundingClientRect().height : 0; },
  };
  window.OSK = OSK;
})();
