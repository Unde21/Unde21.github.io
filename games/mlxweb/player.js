/*
 * player.js — the game page around a MiniLibX program: start screen,
 * loading bar, map picker, sound, fullscreen, and "play again" on exit.
 */
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }

  function mount(cfg) {
    const stage = $('#stage');
    const canvas = $('#screen');
    const overlay = $('#overlay');
    const title = $('#overlay-title');
    const text = $('#overlay-text');
    const startBtn = $('#start');
    const bar = $('#progress');
    const barFill = $('#progress span');
    const mapSel = $('#map');
    const variantSel = $('#variant');
    const soundBtn = $('#sound');
    const fsBtn = $('#fullscreen');
    const restartBtn = $('#restart');
    const logBox = $('#log');

    let game = null;
    let muted = false;
    const isolated = !!self.crossOriginIsolated;
    // A threaded build needs SharedArrayBuffer; otherwise use its single-core
    // build (pthreads emulated as fibers) when the page provides one.
    const usable = (v) => !v.threads || isolated || !!v.singleCoreWasm;

    // variants (e.g. Cub3D bonus needs threads -> cross-origin isolation)
    const variants = cfg.variants;
    if (variantSel) {
      variants.forEach((v, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = v.label + (usable(v) ? '' : ' (indisponible ici)');
        o.disabled = !usable(v);
        variantSel.appendChild(o);
      });
      const firstOk = variants.findIndex(usable);
      variantSel.value = String(firstOk);
      variantSel.addEventListener('change', () => { fillMaps(); stop(); showStart(); });
    }
    function variant() { return variants[variantSel ? +variantSel.value : 0]; }
    function fillMaps() {
      mapSel.innerHTML = '';
      variant().maps.forEach((m) => {
        const o = document.createElement('option');
        o.value = m.path; o.textContent = m.label;
        mapSel.appendChild(o);
      });
      const note = $('#variant-note');
      if (note) note.textContent = variant().note || '';
    }
    fillMaps();
    mapSel.addEventListener('change', () => { stop(); showStart(); });

    function log(line) {
      if (!logBox) return;
      logBox.textContent += line + '\n';
      logBox.scrollTop = logBox.scrollHeight;
    }

    function setOverlay(state, t, body, btnLabel) {
      overlay.hidden = state === 'hidden';
      overlay.dataset.state = state;
      title.textContent = t || '';
      text.textContent = body || '';
      startBtn.hidden = !btnLabel;
      if (btnLabel) startBtn.textContent = btnLabel;
      bar.hidden = state !== 'loading';
    }
    function showStart() {
      const v = variant();
      if (!usable(v)) {
        setOverlay('error', 'Version indisponible ici', 'Cette version utilise des threads, qui demandent une page isolée (COOP/COEP). Elle fonctionne sur le site publié.', '');
        return;
      }
      setOverlay('ready', cfg.title, v.pitch || cfg.pitch || '', 'Lancer la partie');
    }

    function fitStage(w, h) {
      stage.style.setProperty('--ratio', w + ' / ' + h);
      stage.style.setProperty('--w', String(w));
      stage.style.setProperty('--h', String(h));
    }
    if (cfg.size) fitStage(cfg.size[0], cfg.size[1]);

    function stop() {
      if (game) { game.stop(); game = null; }
    }

    async function start() {
      stop();
      const v = variant();
      setOverlay('loading', 'Chargement…', v.loadingText || 'Téléchargement du programme et de ses fichiers.', '');
      barFill.style.width = '0%';
      if (logBox) logBox.textContent = '';
      try {
        game = await MlxWeb.start({
          canvas,
          wasm: v.threads && !isolated ? v.singleCoreWasm : v.wasm,
          assets: v.assets,
          program: v.program,
          args: [mapSel.value],
          loopRate: v.loopRate,
          budgetMs: v.budgetMs || 10,
          mouse: v.mouse || 'absolute',
          threads: isolated ? v.threads || 0 : 0,
          workerUrl: cfg.workerUrl || 'games/mlxweb/runtime-worker.js',
          soundBase: v.soundBase || '',
          muted,
          screen: v.screen,
          onProgress: (p) => { barFill.style.width = Math.round(p * 100) + '%'; },
          onWindow: (w, h) => fitStage(w, h),
          onStdout: (s, l) => { log(l); if (s === 2) console.warn('[stderr] ' + l); },
          onExit: (code, err) => {
            game = null;
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
            if (err) setOverlay('error', 'Le programme s’est arrêté', String(err.message || err), 'Relancer');
            else setOverlay('ended', 'Partie terminée', code === 0 ? 'Le programme a quitté normalement.' : 'Le programme a quitté avec le code ' + code + '.', 'Rejouer');
          },
        });
        window.currentGame = game;
        if (!game.finished) setOverlay('hidden');
        canvas.focus();
      } catch (e) {
        console.error(e);
        game = null;
        setOverlay('error', 'Impossible de lancer le jeu', String(e.message || e), 'Réessayer');
      }
    }

    startBtn.addEventListener('click', start);
    if (restartBtn) restartBtn.addEventListener('click', start);
    if (soundBtn) {
      soundBtn.addEventListener('click', () => {
        muted = !muted;
        soundBtn.setAttribute('aria-pressed', String(!muted));
        soundBtn.textContent = muted ? 'Son coupé' : 'Son activé';
        if (game) game.setMuted(muted);
      });
    }
    if (fsBtn) {
      if (!stage.requestFullscreen) fsBtn.hidden = true;
      fsBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else stage.requestFullscreen().then(() => canvas.focus()).catch(() => {});
      });
    }
    showStart();
    localizeKeys();
  }

  // Keys follow their physical position (WASD on QWERTY = ZQSD on AZERTY):
  // show each key with the label of the visitor's own layout when known.
  function localizeKeys() {
    if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return;
    navigator.keyboard.getLayoutMap().then((map) => {
      document.querySelectorAll('kbd[data-code]').forEach((k) => {
        const label = map.get(k.dataset.code);
        if (label) k.textContent = label.toUpperCase();
      });
    }).catch(() => {});
  }

  window.Player = { mount };
})();
