(() => {
  'use strict';

  // ── small helpers ────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dahih.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dahih.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isArabic = (s) => /[؀-ۿ]/.test(s || '');
  const fmt = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/[ؐ-ًؚ-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  const yearOf = (ts) => (ts ? new Date(ts * 1000).getFullYear() : null);

  const el = {
    library: $('#library'), watch: $('#watch'), grid: $('#grid'), empty: $('#empty'), banner: $('#banner'),
    count: $('#count'), chips: $('#eraChips'), sort: $('#sort'), search: $('#search'), refresh: $('#refreshBtn'),
    back: $('#backBtn'), title: $('#vTitle'), info: $('#vInfo'), ytLink: $('#ytLink'), older: $('#olderBtn'),
    newer: $('#newerBtn'), restart: $('#restartBtn'), playerMsg: $('#playerMsg'), transcript: $('.transcript'),
    rows: $('#rows'), txSource: $('#txSource'), enSeg: $('#enSeg'), follow: $('#followBtn'), resume: $('#resumeBtn'),
    swap: $('#swapBtn'), smaller: $('#smallerBtn'), larger: $('#largerBtn'),
  };

  const state = {
    reg: { videos: [], eras: [], building: false, progress: [], errors: [], complete: false },
    era: store.get('era', 'all'),
    sort: store.get('sort', 'new'),
    q: '',
    current: null,
    tx: null,
    rows: [],
    starts: [],
    active: -1,
    follow: true,
    enPref: store.get('enPref', null),
    swapped: store.get('swapped', false),
    fs: store.get('fs', 14.5),
    watched: store.get('progress', {}),
  };

  // ── registry / library ───────────────────────────────────────────
  let regTimer = null;
  async function loadRegistry() {
    clearTimeout(regTimer);
    try {
      const r = await fetch('/api/registry');
      state.reg = await r.json();
    } catch {
      state.reg.errors = [{ source: 'app', message: 'Can’t reach the local server. Start it again with start.command.' }];
      state.reg.building = false;
    }
    renderLibrary();
    if (state.current) renderMeta();
    if (state.reg.building) regTimer = setTimeout(loadRegistry, 2000);
  }

  function eraInfo(key) {
    return state.reg.eras.find((e) => e.key === key) || { key, label: key || '', years: '' };
  }

  function visible() {
    let v = state.reg.videos;
    if (state.era !== 'all') v = v.filter((x) => x.era === state.era);
    if (state.q) {
      const q = norm(state.q.trim());
      v = v.filter((x) => norm(x.title).includes(q) || x.id === state.q.trim());
    }
    if (state.sort === 'new') v = [...v].reverse();
    if (state.sort === 'recent') {
      v = v.filter((x) => state.watched[x.id]).sort((a, b) => state.watched[b.id].at - state.watched[a.id].at);
    }
    return v;
  }

  function renderLibrary() {
    const { videos, eras, building, complete, progress, errors } = state.reg;

    // channel chips
    const counts = {};
    for (const v of videos) counts[v.era] = (counts[v.era] || 0) + 1;
    const chips = [{ key: 'all', label: 'All', n: videos.length }, ...eras.map((e) => ({ key: e.key, label: e.label, n: counts[e.key] || 0, years: e.years }))];
    if (!chips.some((c) => c.key === state.era)) state.era = 'all';
    el.chips.innerHTML = chips.map((c) =>
      `<button class="chip" role="tab" data-era="${esc(c.key)}" aria-selected="${c.key === state.era}" title="${esc(c.years || '')}">${esc(c.label)}<span class="n">${c.n}</span></button>`).join('');
    el.sort.value = state.sort;

    // status banner
    let banner = '';
    if (building) {
      const found = progress.reduce((n, p) => n + p.count, 0);
      banner = complete
        ? `<span class="spinner"></span>Checking YouTube for new episodes…`
        : `<span class="spinner"></span><span>Building the episode list from YouTube — first run takes a minute or two. <b>${found}</b> found so far` +
          (progress.length ? ` <span style="color:var(--faint)">(${progress.map((p) => `${esc(p.source)}: ${p.count}${p.done ? '' : '…'}`).join(' · ')})</span>` : '') + `</span>`;
    } else if (errors.length) {
      banner = errors.map((e) => `Couldn’t read <b>${esc(e.source)}</b>: ${esc(e.message)}`).join('<br>');
    }
    el.banner.innerHTML = banner;
    el.banner.hidden = !banner;
    el.banner.classList.toggle('err', !building && errors.length > 0);
    el.refresh.disabled = building;

    // grid
    const list = visible();
    el.count.textContent = videos.length ? `${list.length}${list.length !== videos.length ? ' of ' + videos.length : ''} episodes` : '';
    el.grid.innerHTML = list.map(card).join('');
    let emptyMsg = '';
    if (!list.length) {
      if (!videos.length) emptyMsg = building ? '' : 'No episodes yet. Press “Refresh list” to fetch them from YouTube.';
      else if (state.sort === 'recent') emptyMsg = 'Nothing watched yet.';
      else emptyMsg = 'No episodes match your search.';
    }
    el.empty.textContent = emptyMsg;
    el.empty.hidden = !emptyMsg;
  }

  function card(v) {
    const w = state.watched[v.id];
    const pct = w && w.d ? Math.min(100, (w.t / w.d) * 100) : 0;
    const dir = isArabic(v.title) ? 'rtl' : 'ltr';
    const yr = yearOf(v.ts);
    const sub = [eraInfo(v.era).label, yr ? '~' + yr : ''].filter(Boolean).map(esc).join(' · ');
    return `<a class="card" href="#/watch/${v.id}">
      <div class="thumb">
        <img loading="lazy" src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="">
        ${v.duration ? `<span class="dur">${fmt(v.duration)}</span>` : ''}
        ${pct > 1 ? `<span class="prog"><i style="width:${pct.toFixed(1)}%"></i></span>` : ''}
      </div>
      <p class="card-title" dir="${dir}" ${dir === 'rtl' ? 'lang="ar"' : ''}>${esc(v.title)}</p>
      <p class="card-sub">${sub}</p>
    </a>`;
  }

  el.chips.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.era = b.dataset.era;
    store.set('era', state.era);
    renderLibrary();
  });
  el.sort.addEventListener('change', () => { state.sort = el.sort.value; store.set('sort', state.sort); renderLibrary(); });
  el.search.addEventListener('input', () => {
    state.q = el.search.value;
    if (!el.watch.hidden) location.hash = '#/';
    renderLibrary();
  });
  el.refresh.addEventListener('click', async () => {
    el.refresh.disabled = true;
    try { await fetch('/api/registry/refresh', { method: 'POST' }); } catch { /* shown by loadRegistry */ }
    loadRegistry();
  });

  // ── routing ──────────────────────────────────────────────────────
  function route() {
    const m = location.hash.match(/^#\/watch\/([A-Za-z0-9_-]{11})/);
    if (m) openVideo(m[1]);
    else showLibrary();
  }
  window.addEventListener('hashchange', route);
  el.back.addEventListener('click', () => { location.hash = '#/'; });

  function showLibrary() {
    el.watch.hidden = true;
    el.library.hidden = false;
    el.back.hidden = true;
    document.title = 'El Dahih Player';
    if (player && player.pauseVideo) player.pauseVideo();
    renderLibrary();
  }

  // ── player ───────────────────────────────────────────────────────
  let player = null;
  let ytApi = null;
  let playerCreating = null;

  function loadYT() {
    if (window.__FAKE_YT__) return Promise.resolve(window.__FAKE_YT__); // used by the test harness
    if (!ytApi) {
      ytApi = new Promise((resolve, reject) => {
        if (window.YT && window.YT.Player) return resolve(window.YT);
        window.onYouTubeIframeAPIReady = () => resolve(window.YT);
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => { ytApi = null; reject(new Error('Couldn’t load the YouTube player. Are you online?')); };
        document.head.appendChild(s);
      });
    }
    return ytApi;
  }

  async function playVideo(id, start) {
    const YT = await loadYT();
    if (playerCreating) await playerCreating;
    if (player) {
      player.loadVideoById({ videoId: id, startSeconds: start || 0 });
      return;
    }
    playerCreating = new Promise((resolve) => {
      player = new YT.Player('yt', {
        videoId: id,
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, iv_load_policy: 3, cc_load_policy: 0, start: Math.floor(start || 0), origin: location.origin },
        events: { onReady: resolve, onStateChange: onPlayerState, onError: onPlayerError },
      });
    });
    await playerCreating;
    playerCreating = null;
  }

  function onPlayerState() {
    const cur = state.current;
    if (cur && !cur.title && player.getVideoData) {
      const d = player.getVideoData();
      if (d && d.title) { cur.title = d.title; renderMeta(); }
    }
    tick();
  }

  function onPlayerError(e) {
    const id = state.current && state.current.id;
    const link = `<a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">Watch it on YouTube ↗</a>`;
    const why = {
      101: 'The uploader doesn’t allow this video to play outside YouTube.',
      150: 'The uploader doesn’t allow this video to play outside YouTube.',
      100: 'This video was removed or made private.',
      2: 'YouTube didn’t recognise this video.',
      5: 'The video player hit a playback error.',
    }[e.data] || 'The video couldn’t be played here.';
    el.playerMsg.innerHTML = `<div>${esc(why)}</div><div>${link}</div><div style="color:#9aa3b2;font-size:12.5px">The transcript is still available on the right.</div>`;
    el.playerMsg.hidden = false;
  }

  async function openVideo(id) {
    el.library.hidden = true;
    el.watch.hidden = false;
    el.back.hidden = false;
    if (state.current && state.current.id === id) return;

    const v = state.reg.videos.find((x) => x.id === id);
    state.current = v ? { ...v } : { id, title: '', era: null };
    renderMeta();
    el.playerMsg.hidden = true;
    setFollow(true);
    loadTranscript(id);

    const saved = state.watched[id];
    const start = saved && saved.t > 15 && (!saved.d || saved.t < saved.d - 30) ? saved.t : 0;
    el.restart.hidden = !start;
    try {
      await playVideo(id, start);
    } catch (err) {
      el.playerMsg.innerHTML = `<div>${esc(err.message)}</div>`;
      el.playerMsg.hidden = false;
    }
  }

  function neighbours() {
    const list = state.reg.videos; // oldest first
    const i = state.current ? list.findIndex((x) => x.id === state.current.id) : -1;
    return { older: i > 0 ? list[i - 1] : null, newer: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
  }

  function renderMeta() {
    const v = state.current;
    if (!v) return;
    const fresh = state.reg.videos.find((x) => x.id === v.id);
    if (fresh && !v.title) Object.assign(v, fresh);
    el.title.textContent = v.title || 'Loading…';
    el.title.dir = isArabic(v.title) ? 'rtl' : 'ltr';
    el.title.lang = isArabic(v.title) ? 'ar' : 'en';
    document.title = (v.title ? v.title + ' · ' : '') + 'El Dahih Player';
    const era = v.era ? eraInfo(v.era) : null;
    const yr = yearOf(v.ts);
    el.info.textContent = [v.channel || (era && era.label), yr ? '~' + yr : '', v.duration ? fmt(v.duration) : '']
      .filter(Boolean).join(' · ');
    el.ytLink.href = `https://www.youtube.com/watch?v=${v.id}`;
    const n = neighbours();
    el.older.disabled = !n.older;
    el.newer.disabled = !n.newer;
    el.older.title = n.older ? n.older.title : '';
    el.newer.title = n.newer ? n.newer.title : '';
  }

  el.older.addEventListener('click', () => { const n = neighbours().older; if (n) location.hash = '#/watch/' + n.id; });
  el.newer.addEventListener('click', () => { const n = neighbours().newer; if (n) location.hash = '#/watch/' + n.id; });
  el.restart.addEventListener('click', () => { seek(0); el.restart.hidden = true; });

  // ── transcript ───────────────────────────────────────────────────
  let txReq = 0;
  const KIND = {
    official: 'official captions',
    auto: 'auto-generated',
    translated: 'YouTube translation',
  };

  async function loadTranscript(id) {
    const my = ++txReq;
    state.tx = null; state.rows = []; state.starts = []; state.active = -1;
    el.enSeg.hidden = true;
    el.txSource.textContent = 'Loading captions from YouTube…';
    el.rows.innerHTML = '<div class="skeleton">' + '<i style="width:92%"></i><i style="width:74%"></i><i style="width:85%"></i><i style="width:66%"></i><i style="width:80%"></i>'.repeat(2) + '</div>';
    let data, ok;
    try {
      const r = await fetch(`/api/transcript?id=${id}${state.enPref ? '&en=' + state.enPref : ''}`);
      ok = r.ok;
      data = await r.json();
    } catch {
      ok = false;
      data = { message: 'Can’t reach the local server. Start it again with start.command.' };
    }
    if (my !== txReq) return; // user already moved on to another episode
    if (!ok) {
      el.txSource.textContent = '';
      el.rows.innerHTML = `<div class="tx-state"><div>${esc(data.message || 'Couldn’t load captions.')}</div>
        ${data.error === 'blocked' || data.error === 'fetch_failed' || !data.error ? '<button class="ghost small" id="retryTx">Try again</button>' : ''}</div>`;
      const retry = $('#retryTx');
      if (retry) retry.onclick = () => loadTranscript(id);
      return;
    }
    state.tx = data;
    state.rows = data.rows;
    state.starts = data.rows.map((r) => r.t);
    renderRows();
    renderTxHead();
    tick(true);
  }

  function renderTxHead() {
    const tx = state.tx;
    if (!tx) return;
    const en = tx.en_kind ? `English: ${KIND[tx.en_kind]}` : 'No English available';
    el.txSource.textContent = `${state.rows.length} lines · Arabic: ${KIND[tx.ar_kind]} · ${en}`;
    const opts = tx.en_options || [];
    el.enSeg.hidden = opts.length < 2;
    el.enSeg.innerHTML = opts.map((o) =>
      `<button data-en="${o}" aria-pressed="${o === tx.en_kind}" title="English source">${o === 'translated' ? 'Translated' : o === 'official' ? 'Official EN' : 'Auto EN'}</button>`).join('');
  }

  el.enSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !state.current || (state.tx && b.dataset.en === state.tx.en_kind)) return;
    state.enPref = b.dataset.en;
    store.set('enPref', state.enPref);
    loadTranscript(state.current.id);
  });

  function renderRows() {
    if (!state.rows.length) {
      el.rows.innerHTML = '<div class="tx-state">This episode’s captions are empty.</div>';
      return;
    }
    el.rows.innerHTML = state.rows.map((r, i) =>
      `<div class="row" data-i="${i}"><span class="ts">${fmt(r.t)}</span>` +
      `<div class="en" lang="en" dir="ltr">${esc(r.en)}</div>` +
      `<div class="ar" lang="ar" dir="rtl">${esc(r.ar)}</div></div>`).join('');
  }

  // index of the caption that is on screen at time t
  function indexAt(t) {
    const s = state.starts;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] <= t + 0.15) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }

  let lastSaved = 0;
  function tick(force) {
    if (!player || !player.getCurrentTime || el.watch.hidden) return;
    const t = player.getCurrentTime() || 0;
    const i = indexAt(t);
    if (i !== state.active || force) setActive(i, force ? 'auto' : 'smooth');
    const now = Date.now();
    if (now - lastSaved > 4000 && state.current && t > 1) {
      lastSaved = now;
      const d = (player.getDuration && player.getDuration()) || state.current.duration || 0;
      state.watched[state.current.id] = { t: d && t > d - 20 ? d : t, d, at: now };
      store.set('progress', state.watched);
    }
  }
  setInterval(tick, 200);

  function setActive(i, behavior = 'smooth') {
    const prev = el.rows.querySelector('.row.active');
    if (prev) prev.classList.remove('active');
    state.active = i;
    if (i < 0) return;
    const row = el.rows.children[i];
    if (!row) return;
    row.classList.add('active');
    if (state.follow) scrollToRow(row, behavior);
  }

  let autoScrollUntil = 0;
  function scrollToRow(row, behavior = 'smooth') {
    autoScrollUntil = performance.now() + 700;
    const top = row.offsetTop - el.rows.clientHeight * 0.32;
    el.rows.scrollTo({ top: Math.max(0, top), behavior });
  }

  function setFollow(on) {
    state.follow = on;
    el.follow.classList.toggle('on', on);
    el.follow.setAttribute('aria-pressed', String(on));
    el.resume.hidden = on || !state.rows.length;
    if (on && state.active >= 0) {
      const row = el.rows.children[state.active];
      if (row) scrollToRow(row);
    }
  }

  // Any scrolling by the reader pauses follow-along until they ask for it again.
  const userScroll = () => { if (state.follow && performance.now() > autoScrollUntil - 600) setFollow(false); };
  el.rows.addEventListener('wheel', userScroll, { passive: true });
  el.rows.addEventListener('touchmove', userScroll, { passive: true });
  el.rows.addEventListener('pointerdown', (e) => { if (e.target === el.rows) userScroll(); });
  el.rows.addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) userScroll(); });

  el.rows.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row || String(window.getSelection() || '').length) return; // don't jump while selecting text
    seek(state.rows[+row.dataset.i].t);
  });

  function seek(t) {
    if (!player || !player.seekTo) return;
    player.seekTo(t, true);
    if (player.playVideo) player.playVideo();
    setFollow(true);
    const i = indexAt(t);
    setActive(i);
  }

  el.follow.addEventListener('click', () => setFollow(!state.follow));
  el.resume.addEventListener('click', () => setFollow(true));

  function applyPrefs() {
    el.transcript.classList.toggle('swapped', state.swapped);
    document.documentElement.style.setProperty('--fs', state.fs + 'px');
  }
  el.swap.addEventListener('click', () => { state.swapped = !state.swapped; store.set('swapped', state.swapped); applyPrefs(); });
  el.smaller.addEventListener('click', () => { state.fs = Math.max(12, state.fs - 1); store.set('fs', state.fs); applyPrefs(); });
  el.larger.addEventListener('click', () => { state.fs = Math.min(22, state.fs + 1); store.set('fs', state.fs); applyPrefs(); });

  // ── keyboard ─────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches('input, textarea, select')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === '/') { e.preventDefault(); el.search.focus(); return; }
    if (el.watch.hidden || !player) return;
    switch (e.key) {
      case ' ': case 'k':
        e.preventDefault();
        if (player.getPlayerState && player.getPlayerState() === 1) player.pauseVideo(); else player.playVideo();
        break;
      case 'ArrowLeft': case 'j':
        e.preventDefault(); step(-1); break;
      case 'ArrowRight': case 'l':
        e.preventDefault(); step(1); break;
      case 'f':
        setFollow(!state.follow); break;
      case 'Escape':
        location.hash = '#/'; break;
      default:
    }
  });

  function step(d) {
    if (!state.rows.length) return;
    const t = player.getCurrentTime ? player.getCurrentTime() : 0;
    const cur = indexAt(t);
    // "previous" from the middle of a line restarts it first, like a music player
    let i = d < 0 && cur >= 0 && t - state.starts[cur] > 1.5 ? cur : cur + d;
    i = Math.max(0, Math.min(state.rows.length - 1, i));
    seek(state.rows[i].t);
  }

  // ── start ────────────────────────────────────────────────────────
  applyPrefs();
  loadRegistry().then(route);
  if (!location.hash) history.replaceState(null, '', '#/');
})();
