/* Admin panel: every game, photo downloads, cleanup. */
(function () {
  'use strict';
  const { $, h, api, toast, fmtBytes } = window.SV;

  const phaseLabel = (g) => {
    if (g.finishedAt) return h('span', { class: 'pill green' }, 'Finished');
    if (g.phase === 'lobby') return h('span', { class: 'pill' }, 'In lobby');
    return h('span', { class: 'pill pink' }, `In progress · ${g.phase}`);
  };

  async function load() {
    const box = $('#games');
    try {
      const data = await api('/api/admin/games');
      const { usedBytes, limitBytes } = data.storage;
      const pct = Math.min(100, (usedBytes / limitBytes) * 100);
      $('#storage-bar').style.width = `${Math.max(pct, 0.5)}%`;
      $('#storage-text').textContent = `${fmtBytes(usedBytes)} of ${fmtBytes(limitBytes)} used (${pct.toFixed(pct < 1 ? 2 : 0)}%)`;
      if (!data.games.length) {
        box.replaceChildren(h('div', { class: 'card center' }, h('p', {}, 'No games yet.'), h('a', { class: 'btn primary', href: '/host' }, 'Host your first game')));
        return;
      }
      box.replaceChildren(...data.games.map(gameCard));
    } catch (err) {
      box.replaceChildren(h('div', { class: 'banner error' }, err.message));
    }
  }

  function gameCard(g) {
    const dl = h('button', { class: 'btn primary', type: 'button', disabled: g.photos === 0 }, '📦 Download photos (.zip)');
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      try {
        const r = await SV.downloadGameZip(g.code, (f) => { dl.textContent = `Preparing… ${Math.round(f * 100)}%`; });
        toast(`Downloaded ${r.photos} photos (${fmtBytes(r.bytes)})`);
      } catch (err) { toast(err.message, 'error'); }
      dl.disabled = false; dl.textContent = '📦 Download photos (.zip)';
    });
    const gallery = h('div', { hidden: true, style: { marginTop: '16px' } });
    const view = h('button', { class: 'btn', type: 'button', disabled: g.photos === 0 }, 'View photos');
    view.addEventListener('click', async () => {
      if (!gallery.hidden) { gallery.hidden = true; view.textContent = 'View photos'; return; }
      view.disabled = true;
      try {
        const m = await api(`/api/admin/games/${g.code}`);
        gallery.replaceChildren(...m.rounds.map((r) => {
          const imgs = m.images.filter((i) => i.round === r.number && i.kind === 'sub');
          return h('div', { style: { marginBottom: '16px' } },
            h('h3', {}, `Round ${r.number}: ${r.task}`),
            imgs.length ? h('div', { class: 'grid' }, imgs.map((i) => h('div', { class: 'tile' },
              h('img', { src: `/img/${i.id}`, alt: i.nickname, loading: 'lazy' }),
              h('button', { class: 'zoom', type: 'button', 'aria-label': 'Enlarge', onclick: () => SV.openLightbox(`/img/${i.id}`, `${i.nickname} · ${i.votes} votes`) }, '⤢'),
              h('div', { class: 'caption' }, h('span', { class: 'name' }, i.nickname), h('span', {}, `${i.votes} ♥`))))) : h('p', { class: 'faint' }, 'No photos.'));
        }));
        gallery.hidden = false;
        view.textContent = 'Hide photos';
      } catch (err) { toast(err.message, 'error'); }
      view.disabled = false;
    });
    const del = h('button', { class: 'btn danger', type: 'button' }, 'Delete');
    del.addEventListener('click', async () => {
      const typed = prompt(`Delete game ${g.code} and all ${g.photos} photos for good?\nDownload them first if you want to keep them.\n\nType the game code to confirm:`);
      if (!typed || typed.trim().toUpperCase() !== g.code) return;
      try {
        await api(`/api/admin/games/${g.code}`, { method: 'DELETE' });
        toast(`Deleted ${g.code}`);
        load();
      } catch (err) { toast(err.message, 'error'); }
    });
    const date = new Date(g.createdAt).toLocaleString();
    return h('div', { class: 'card game-card' },
      h('div', { class: 'row between' }, h('h2', { style: { margin: 0, letterSpacing: '0.08em' } }, g.code), phaseLabel(g)),
      h('div', { class: 'stats muted' },
        h('span', {}, date), g.hostName ? h('span', {}, `Host: ${g.hostName}`) : null,
        h('span', {}, `${g.rounds} round${g.rounds === 1 ? '' : 's'}`), h('span', {}, `${g.players} player${g.players === 1 ? '' : 's'}`),
        h('span', {}, `${g.photos} photo${g.photos === 1 ? '' : 's'} · ${fmtBytes(g.bytes)}`)),
      h('p', { class: 'faint' }, g.tasks.map((t, i) => `${i + 1}. ${t}`).join('   ')),
      h('div', { class: 'row' }, dl, view, h('span', { class: 'spacer' }), del),
      gallery);
  }

  $('#refresh').addEventListener('click', load);
  load();
})();
