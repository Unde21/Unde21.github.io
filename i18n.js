/*
 * i18n.js — English / French for the whole site.
 *
 * Static text: the English stays in the HTML, the French sits next to it.
 *   <p data-fr="Bonjour">Hello</p>            innerHTML
 *   <img alt="A cat" data-fr-alt="Un chat">   attributes (alt, title, aria-label, placeholder, content, value)
 * Text built by scripts: I18N.t('Hello', 'Bonjour'), or I18N.L({ en, fr }).
 * I18N.onChange(fn) runs fn after each switch, so scripts can redraw.
 *
 * The choice is kept in localStorage; the first visit follows the browser.
 */
(function () {
  'use strict';
  const KEY = 'site-lang';
  const ATTRS = ['alt', 'title', 'aria-label', 'placeholder', 'content', 'value'];
  const root = document.documentElement;
  let lang = null;
  try { lang = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
  if (lang !== 'en' && lang !== 'fr') lang = /^fr\b/i.test(navigator.language || '') ? 'fr' : 'en';
  root.lang = lang;
  // French visitors would otherwise see the English text for a frame
  if (lang === 'fr') {
    root.classList.add('i18n-pending');
    setTimeout(() => root.classList.remove('i18n-pending'), 1500);
  }

  const listeners = [];

  function apply() {
    document.querySelectorAll('[data-fr]').forEach((el) => {
      if (el.__en === undefined) el.__en = el.innerHTML;
      const html = lang === 'fr' ? el.dataset.fr : el.__en;
      if (el.innerHTML !== html) el.innerHTML = html;
    });
    for (const a of ATTRS) {
      document.querySelectorAll('[data-fr-' + a + ']').forEach((el) => {
        const k = '__en_' + a;
        if (el[k] === undefined) el[k] = el.getAttribute(a);
        el.setAttribute(a, lang === 'fr' ? el.getAttribute('data-fr-' + a) : el[k]);
      });
    }
    document.querySelectorAll('.lang-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  }

  function set(next) {
    if (next !== 'en' && next !== 'fr' || next === lang) return;
    lang = next;
    root.lang = lang;
    try { localStorage.setItem(KEY, lang); } catch (e) { /* storage blocked */ }
    apply();
    for (const fn of listeners) { try { fn(lang); } catch (e) { console.error(e); } }
  }

  function switcher() {
    const box = document.createElement('div');
    box.className = 'lang-switch';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Language / Langue');
    for (const [code, label, name] of [['en', 'EN', 'English'], ['fr', 'FR', 'Français']]) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.lang = code; b.textContent = label; b.title = name;
      b.setAttribute('lang', code);
      b.addEventListener('click', () => set(code));
      box.appendChild(b);
    }
    const slot = document.querySelector('[data-lang-slot]');
    const bar = document.querySelector('.bar .wrap');
    if (slot) slot.appendChild(box);
    else if (bar) bar.insertBefore(box, bar.querySelector('.spacer') ? bar.querySelector('.spacer').nextSibling : null);
    else { box.classList.add('floating'); document.body.appendChild(box); }
  }

  function ready() {
    switcher();
    apply();
    root.classList.remove('i18n-pending');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  window.I18N = {
    get lang() { return lang; },
    t: (en, fr) => (lang === 'fr' && fr !== undefined ? fr : en),
    L: (x) => (x && typeof x === 'object' ? (lang === 'fr' && x.fr !== undefined ? x.fr : x.en) : x),
    set,
    apply,
    onChange: (fn) => { listeners.push(fn); },
  };
})();
