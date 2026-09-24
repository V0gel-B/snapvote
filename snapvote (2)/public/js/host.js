/* Host screen: set up rounds, run the big screen, reveal the winner. */
(function () {
  'use strict';
  const { $, h, api, toast, store, bindTimer, timerRing } = window.SV;
  const { renderBoard, resultsGrid, createCeremony } = window.SVViews;

  const stage = $('#stage');
  const DRAFT_KEY = 'sv:host:draft';
  const GAME_KEY = 'sv:host';
  const S = { code: null, hostToken: null, conn: null, state: null, key: null, ui: {}, prevScores: null };

  const IDEAS = [
    'Something red', 'Your best fake smile', 'The weirdest object within 5 metres', 'Recreate a famous painting',
    'A shadow that looks like an animal', 'Your shoes, but make it art', 'Something that is secretly a face',
    'The most boring photo possible', 'A tiny thing that looks huge', 'Your "Monday morning" face',
    'Two things that should never touch', 'Something older than you', 'An accidental masterpiece',
    'The best view you can find right now', 'Your team as a boy band album cover', 'A plant looking dramatic',
    'Something that smells amazing (trust us)', 'The messiest desk in the building', 'Make a letter of the alphabet with your body',
    'A reflection', 'Food styled like a five-star restaurant', 'Your hidden talent in one shot', 'Something perfectly symmetrical',
    'A selfie with a stranger’s (willing) thumbs-up', 'Your impression of the host', 'The coziest spot around',
    'Something blue and something yellow together', 'A movie poster remake', 'Evidence of a tiny crime', 'Joy.',
  ];
  const randomIdea = () => IDEAS[Math.floor(Math.random() * IDEAS.length)];

  // ================================================================ setup
  function loadDraft() {
    return store.get(DRAFT_KEY) || {
      hostName: '',
      defaults: { submitSeconds: 60, voteSeconds: 30, points: 100 },
      rounds: [{ task: '' }, { task: '' }, { task: '' }],
    };
  }

  function showSetup() {
    S.key = null;
    $('#side').hidden = true;
    $('#stage').parentElement.classList.add('solo');
    $('#code-pill').hidden = true;
    $('#conn').hidden = true;
    const draft = loadDraft();
    const examples = new Map(); // round card -> File
    const saveDraft = () => {
      clearTimeout(saveDraft.t);
      saveDraft.t = setTimeout(() => store.set(DRAFT_KEY, collect(false).draft), 300);
    };
    // Never lose typing to a quick reload/close inside the debounce window.
    const flushDraft = () => { if (list.isConnected) { clearTimeout(saveDraft.t); store.set(DRAFT_KEY, collect(false).draft); } };
    window.addEventListener('pagehide', flushDraft);

    const hostName = h('input', { type: 'text', maxlength: '20', value: draft.hostName, placeholder: 'e.g. Sascha', oninput: saveDraft });
    const defSubmit = h('input', { type: 'number', min: '5', max: '600', value: draft.defaults.submitSeconds, oninput: saveDraft });
    const defVote = h('input', { type: 'number', min: '5', max: '600', value: draft.defaults.voteSeconds, oninput: saveDraft });
    const defPoints = h('input', { type: 'number', min: '1', max: '10000', value: draft.defaults.points, oninput: saveDraft });
    const list = h('div');

    function roundCard(r = {}) {
      const task = h('textarea', { rows: '2', maxlength: '200', placeholder: 'e.g. Find something red', oninput: saveDraft }, r.task || '');
      const points = h('input', { type: 'number', min: '1', max: '10000', placeholder: 'default', value: r.points ?? '', oninput: saveDraft });
      const submit = h('input', { type: 'number', min: '5', max: '600', placeholder: 'default', value: r.submitSeconds ?? '', oninput: saveDraft });
      const vote = h('input', { type: 'number', min: '5', max: '600', placeholder: 'default', value: r.voteSeconds ?? '', oninput: saveDraft });
      const thumb = h('img', { class: 'thumb', alt: 'Example image', hidden: true });
      const file = h('input', { type: 'file', accept: 'image/*' });
      const clear = h('button', { class: 'btn ghost small', type: 'button', hidden: true }, 'Remove image');
      const title = h('strong');
      const card = h('div', { class: 'round-card' },
        h('div', { class: 'row between', style: { marginBottom: '10px' } }, title,
          h('div', { class: 'row' },
            h('button', { class: 'btn ghost small', type: 'button', title: 'Suggest a task', onclick: () => { task.value = randomIdea(); saveDraft(); } }, '🎲 Idea'),
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => { card.remove(); examples.delete(card); renumber(); saveDraft(); } }, 'Delete round'))),
        h('div', { class: 'field' }, h('label', {}, 'Task'), task),
        h('div', { class: 'grid3' },
          h('div', {}, h('label', {}, 'Points per vote'), points),
          h('div', {}, h('label', {}, 'Photo time (s)'), submit),
          h('div', {}, h('label', {}, 'Voting time (s)'), vote)),
        h('div', { class: 'row', style: { marginTop: '12px' } }, thumb,
          h('span', { class: 'btn small file-btn' }, '🖼️ Example image (optional)', file), clear));
      file.addEventListener('change', () => {
        const f = file.files?.[0];
        if (!f) return;
        examples.set(card, f);
        thumb.src = URL.createObjectURL(f);
        thumb.hidden = false; clear.hidden = false;
      });
      clear.addEventListener('click', () => { examples.delete(card); file.value = ''; thumb.hidden = true; clear.hidden = true; });
      card._read = () => ({ task: task.value.trim(), points: points.value, submitSeconds: submit.value, voteSeconds: vote.value });
      card._title = title;
      return card;
    }
    function renumber() { [...list.children].forEach((c, i) => { c._title.textContent = `Round ${i + 1}`; }); }
    for (const r of draft.rounds) list.append(roundCard(r));
    renumber();

    function collect(strict) {
      const defaults = { submitSeconds: Number(defSubmit.value) || 60, voteSeconds: Number(defVote.value) || 30, points: Number(defPoints.value) || 100 };
      const raw = [...list.children].map((c) => c._read());
      const rounds = raw.map((r) => ({
        task: r.task,
        points: Number(r.points) || defaults.points,
        submitSeconds: Number(r.submitSeconds) || defaults.submitSeconds,
        voteSeconds: Number(r.voteSeconds) || defaults.voteSeconds,
      }));
      if (strict) {
        if (!rounds.length) throw new Error('Add at least one round.');
        const empty = rounds.findIndex((r) => !r.task);
        if (empty !== -1) throw new Error(`Round ${empty + 1} needs a task (or tap 🎲 Idea).`);
      }
      return { config: { hostName: hostName.value.trim(), rounds }, draft: { hostName: hostName.value, defaults, rounds: raw } };
    }

    const create = h('button', { class: 'btn primary block big', type: 'button' }, 'Create game & show the join code →');
    create.addEventListener('click', async () => {
      let data;
      try { data = collect(true); } catch (err) { return toast(err.message, 'error'); }
      create.disabled = true; create.textContent = 'Creating…';
      try {
        const fd = new FormData();
        fd.append('config', JSON.stringify(data.config));
        const cards = [...list.children];
        for (let i = 0; i < cards.length; i++) {
          const f = examples.get(cards[i]);
          if (f) fd.append(`example_${i}`, await SV.compressImage(f, { maxDim: 1200, maxBytes: 450_000 }), `example-${i}.jpg`);
        }
        const res = await api('/api/games', { method: 'POST', body: fd });
        store.set(GAME_KEY, { code: res.code, hostToken: res.hostToken });
        startHost(res.code, res.hostToken);
      } catch (err) {
        toast(err.message, 'error');
        create.disabled = false; create.textContent = 'Create game & show the join code →';
      }
    });

    stage.replaceChildren(
      h('div', { class: 'card' },
        h('h1', {}, 'Set up a game'),
        h('p', {}, 'One task per round. Players get the photo time to upload, then the voting time to pick up to 3 favourites. Each vote is worth the round’s points.'),
        h('div', { class: 'field' }, h('label', {}, 'Your name (shown to players)'), hostName),
        h('div', { class: 'round-card', style: { background: 'transparent' } },
          h('strong', {}, 'Defaults for every round'),
          h('div', { class: 'grid3', style: { marginTop: '10px' } },
            h('div', {}, h('label', {}, 'Points per vote'), defPoints),
            h('div', {}, h('label', {}, 'Photo time (s)'), defSubmit),
            h('div', {}, h('label', {}, 'Voting time (s)'), defVote)))),
      h('div', { class: 'card' },
        h('div', { class: 'row between', style: { marginBottom: '12px' } }, h('h2', { style: { margin: 0 } }, 'Rounds'),
          h('button', { class: 'btn small', type: 'button', onclick: () => { list.append(roundCard({ task: '' })); renumber(); saveDraft(); } }, '+ Add round')),
        list),
      create);
  }

  // ================================================================ live game
  function startHost(code, token) {
    S.code = code; S.hostToken = token; S.key = null;
    $('#code-pill').textContent = `Game ${code}`;
    $('#code-pill').hidden = false;
    $('#conn').hidden = false;
    stage.replaceChildren(h('div', { class: 'card center' }, h('p', {}, 'Connecting…')));
    S.conn = SV.connect({ code, role: 'host', token }, {
      onState,
      onStatus: SV.statusDot,
      onEnd: (c) => {
        if (c === 4000) { store.del(GAME_KEY); toast('That game was deleted.'); showSetup(); }
      },
    });
  }

  const joinUrl = () => `${location.origin}/play?code=${S.code}`;
  function qr(text, mini) {
    const box = h('div', { class: `qr${mini ? ' mini' : ''}`, role: 'img', 'aria-label': `QR code for ${text}` });
    try {
      const q = window.qrcode(0, 'M');
      q.addData(text);
      q.make();
      box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch { box.textContent = text; }
    return box;
  }

  function onState(s) {
    const prev = S.state;
    S.state = s;
    if (prev && prev.phase !== 'results' && s.phase === 'results') S.prevScores = new Map(prev.players.map((p) => [p.id, p.score]));
    if (s.phase !== 'results') S.prevScores = null;
    $('#side').hidden = s.phase === 'lobby';
    $('#stage').parentElement.classList.toggle('solo', s.phase === 'lobby');
    $('#board-note').hidden = !s.scoresHidden;
    renderBoard($('#board'), s.players, { hidden: s.scoresHidden, prevScores: S.prevScores });
    const sideJoin = $('#side-join');
    const showJoin = s.phase !== 'lobby' && s.phase !== 'ceremony';
    sideJoin.hidden = !showJoin;
    if (showJoin && sideJoin.dataset.code !== s.code) {
      sideJoin.dataset.code = s.code;
      sideJoin.replaceChildren(qr(joinUrl(), true), h('p', { class: 'faint', style: { margin: '8px 0 14px' } }, 'Late? Scan to join · ', h('strong', {}, s.code)));
    }
    const key = `${s.phase}:${s.round}`;
    if (key !== S.key) { S.key = key; S.ui = {}; mount[s.phase]?.(s); }
    update[s.phase]?.(s);
  }

  const send = (msg) => S.conn?.send(msg);
  const mount = {};
  const update = {};

  function newGameButton() {
    return h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
      if (!confirm('Leave this game and set up a new one? This game stays in the admin panel.')) return;
      store.del(GAME_KEY); S.conn?.close(); S.conn = null; showSetup();
    } }, 'New game');
  }

  function zipButton(label = '📦 Download all photos (.zip)') {
    const btn = h('button', { class: 'btn', type: 'button' }, label);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await SV.downloadGameZip(S.code, (f) => { btn.textContent = `Preparing… ${Math.round(f * 100)}%`; });
        toast(`Downloaded ${r.photos} photos (${SV.fmtBytes(r.bytes)})`);
      } catch (err) { toast(err.message, 'error'); }
      btn.disabled = false; btn.textContent = label;
    });
    return btn;
  }

  function chips(s, { kick, showDone } = {}) {
    return s.players.map((p) => h('span', { class: `chip${p.online ? '' : ' offline'}${showDone && p.submitted ? ' done' : ''}` },
      h('span', { class: 'status', title: p.online ? 'online' : 'offline' }),
      showDone ? (p.submitted ? '✓ ' : '… ') : '', p.nickname,
      kick ? h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${p.nickname}`, onclick: () => { if (confirm(`Remove ${p.nickname} from the game?`)) send({ t: 'kick', pid: p.id }); } }, '×') : null));
  }

  // ---- lobby
  mount.lobby = (s) => {
    const ui = S.ui;
    ui.chips = h('div', { class: 'chips' });
    ui.count = h('span', { class: 'muted' });
    ui.start = h('button', { class: 'btn primary big', type: 'button', onclick: () => send({ t: 'start' }) }, 'Start the game →');
    const copy = h('button', { class: 'btn small', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(joinUrl()); toast('Join link copied'); } catch { toast(joinUrl()); }
    } }, 'Copy link');
    stage.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'join-panel' },
          qr(joinUrl()),
          h('div', {},
            h('p', { class: 'faint', style: { margin: 0 } }, 'Scan to join, or go to'),
            h('p', { class: 'join-url' }, joinUrl()),
            h('p', { class: 'faint', style: { margin: '10px 0 0' } }, 'Game code'),
            h('div', { class: 'code-big' }, s.code),
            h('p', { class: 'faint', style: { marginTop: '12px' } }, 'Players also need the player password you shared with them (only once per device).'),
            h('div', { class: 'row' }, copy)))),
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, 'Players ', ui.count), newGameButton()),
        h('div', { style: { margin: '14px 0 18px' } }, ui.chips),
        h('div', { class: 'row between' }, h('span', { class: 'faint' }, `${s.totalRounds} round${s.totalRounds === 1 ? '' : 's'} ready · late joiners can hop in any time before the ceremony`), ui.start)));
  };
  update.lobby = (s) => {
    const ui = S.ui;
    ui.count.textContent = `(${s.players.length})`;
    ui.chips.replaceChildren(...(s.players.length ? chips(s, { kick: true }) : [h('p', { class: 'muted', style: { margin: 0 } }, 'Waiting for the first player…')]));
    ui.start.disabled = s.players.length === 0;
  };

  // ---- submit
  mount.submit = (s) => {
    const ui = S.ui;
    ui.timer = timerRing('big');
    ui.bar = h('div', { class: 'progress' }, h('span'));
    ui.progress = h('span', { class: 'pill' });
    ui.chips = h('div', { class: 'chips', style: { justifyContent: 'center' } });
    const example = s.exampleUrl ? h('img', { class: 'example', src: s.exampleUrl, alt: 'Example', onclick: () => SV.openLightbox(s.exampleUrl, 'Example') }) : null;
    stage.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('span', { class: 'pill pink' }, `Round ${s.round} / ${s.totalRounds}`), ui.progress),
      h('div', { class: 'task' }, h('div', { class: 'label' }, 'Snap this'), h('h2', {}, s.task), example, h('p', { class: 'faint', style: { marginTop: '8px' } }, `${s.points} points per vote`)),
      ui.timer, ui.bar,
      h('div', { style: { margin: '16px 0' } }, ui.chips),
      h('div', { class: 'row center' }, h('button', { class: 'btn', type: 'button', onclick: () => send({ t: 'endPhase' }) }, 'End photo time now'))));
    bindTimer(ui.timer, s.deadline, s.deadline - SV.serverNow());
  };
  update.submit = (s) => {
    const { done, total } = s.progress;
    S.ui.progress.textContent = `${done} / ${total} photos in`;
    S.ui.bar.firstChild.style.width = total ? `${(done / total) * 100}%` : '0';
    S.ui.chips.replaceChildren(...chips(s, { showDone: true, kick: true }));
  };

  // ---- vote
  mount.vote = (s) => {
    const ui = S.ui;
    ui.timer = timerRing('big');
    ui.bar = h('div', { class: 'progress' }, h('span'));
    ui.progress = h('span', { class: 'pill' });
    ui.grid = h('div', { class: 'grid large' });
    stage.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('span', { class: 'pill pink' }, `Round ${s.round} — voting`), ui.progress),
      h('div', { class: 'task' }, h('div', { class: 'label' }, 'Vote on your phones!'), h('h2', {}, s.task)),
      ui.timer, ui.bar,
      h('p', { class: 'faint center', style: { margin: '12px 0' } }, 'Anonymous until the results. Spot something inappropriate? Remove it.'),
      ui.grid,
      h('div', { class: 'row center', style: { marginTop: '16px' } }, h('button', { class: 'btn', type: 'button', onclick: () => send({ t: 'endPhase' }) }, 'End voting now'))));
    bindTimer(ui.timer, s.deadline, s.deadline - SV.serverNow());
  };
  update.vote = (s) => {
    const { done, total } = s.progress;
    S.ui.progress.textContent = `${done} / ${total} voted`;
    S.ui.bar.firstChild.style.width = total ? `${(done / total) * 100}%` : '0';
    const ids = s.gallery.map((g) => g.id).join();
    if (S.ui.galleryIds === ids) return;
    S.ui.galleryIds = ids;
    S.ui.grid.replaceChildren(...s.gallery.map((img, i) => h('div', { class: 'tile' },
      h('img', { src: img.url, alt: `Photo ${i + 1}`, loading: 'lazy', decoding: 'async' }),
      h('button', { class: 'btn danger small remove', type: 'button', onclick: () => { if (confirm('Remove this photo from the round?')) send({ t: 'removePhoto', imageId: img.id }); } }, 'Remove'),
      h('button', { class: 'zoom', type: 'button', 'aria-label': 'Enlarge', onclick: () => SV.openLightbox(img.url, `Photo ${i + 1}`) }, '⤢'))));
  };

  // ---- results
  mount.results = (s) => {
    S.ui.box = h('div');
    const last = s.isLastRound;
    stage.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('span', { class: 'pill green' }, `Round ${s.round} / ${s.totalRounds} — results`), newGameButton()),
      h('div', { class: 'task' }, h('h2', {}, s.task)),
      S.ui.box,
      h('div', { class: 'row center', style: { marginTop: '20px' } },
        !last ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (confirm('Skip the remaining rounds and go straight to the ceremony?')) send({ t: 'finishEarly' }); } }, 'End game early') : null,
        h('button', { class: `btn big ${last ? 'gold' : 'primary'}`, type: 'button', onclick: () => send({ t: 'next' }) }, last ? '🏆 Start the ceremony' : `Next round (${s.round + 1}/${s.totalRounds}) →`))));
  };
  update.results = (s) => {
    const sig = s.results.map((r) => r.id).join();
    if (S.ui.sig === sig) return;
    S.ui.sig = sig;
    S.ui.box.replaceChildren(resultsGrid(s.results, { large: true, onRemove: (r) => { if (confirm(`Remove ${r.nickname}'s photo? Its points are taken back.`)) send({ t: 'removePhoto', imageId: r.id }); } }));
  };

  // ---- ceremony
  mount.ceremony = (s) => {
    const ui = S.ui;
    const box = h('div');
    ui.ceremony = createCeremony(box);
    ui.reveal = h('button', { class: 'btn gold big', type: 'button', onclick: () => send({ t: 'reveal' }) });
    ui.after = h('div', { class: 'row center', hidden: true, style: { marginTop: '20px' } }, zipButton(), newGameButton());
    ui.hint = h('p', { class: 'muted' });
    stage.replaceChildren(h('div', { class: 'card stage' },
      h('div', { class: 'trophy' }, '🏆'), h('h1', {}, 'The final ceremony'), ui.hint,
      h('div', { class: 'row center' }, ui.reveal), box, ui.after));
  };
  update.ceremony = (s) => {
    const c = s.ceremony;
    const ui = S.ui;
    const done = c.revealed >= c.total;
    ui.reveal.hidden = done;
    if (!done) ui.reveal.textContent = c.nextIsFinale ? '🥁 Reveal the winner!' : `Reveal #${c.nextRank}`;
    ui.hint.textContent = c.total === 0 ? 'Nobody played — nothing to reveal.' : done ? 'What a game! 🎉' : `Top ${c.total}, revealed from the bottom up.`;
    ui.after.hidden = !done;
    ui.ceremony.render(c);
  };

  // ================================================================ boot
  (async function boot() {
    const saved = store.get(GAME_KEY);
    if (saved?.code && saved?.hostToken) {
      try {
        await api(`/api/admin/games/${saved.code}`);
        return startHost(saved.code, saved.hostToken);
      } catch (err) {
        if (err.status !== 404) toast(err.message, 'error');
        store.del(GAME_KEY);
      }
    }
    showSetup();
  })();
})();
