/* Player screen: join, snap, vote, watch the ceremony. */
(function () {
  'use strict';
  const { $, h, api, toast, store, bindTimer, timerRing } = window.SV;
  const { renderBoard, resultsGrid, createCeremony } = window.SVViews;

  const stage = $('#stage');
  const params = new URLSearchParams(location.search);
  const S = {
    code: (params.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5),
    session: null,
    conn: null,
    state: null,
    key: null,
    ui: {},
    prevScores: null,
  };
  const sessionKey = (code) => `sv:player:${code}`;

  // ------------------------------------------------------------ join
  function showJoin(message) {
    S.key = null;
    $('#side').hidden = true;
    $('#stage').parentElement.classList.add('solo');
    for (const id of ['code-pill', 'me-pill', 'conn', 'leave']) $(`#${id}`).hidden = true;
    const code = h('input', { type: 'text', id: 'join-code', class: 'code-input', maxlength: '5', placeholder: 'ABCDE', autocomplete: 'off', autocapitalize: 'characters', value: S.code, inputmode: 'text', 'aria-label': 'Game code' });
    const name = h('input', { type: 'text', id: 'join-name', maxlength: '20', placeholder: 'e.g. Alex', autocomplete: 'nickname', 'aria-label': 'Your nickname' });
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const btn = h('button', { class: 'btn primary block big', type: 'submit' }, 'Join game →');
    const form = h('form', { novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'join-code' }, 'Game code'), code),
      h('div', { class: 'field' }, h('label', { for: 'join-name' }, 'Your nickname'), name),
      btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (code.value.length !== 5) return toast('The game code has 5 characters.', 'error');
      if (!name.value.trim()) return toast('Pick a nickname.', 'error');
      btn.disabled = true; btn.textContent = 'Joining…';
      try {
        const res = await api(`/api/games/${code.value}/join`, { method: 'POST', json: { nickname: name.value } });
        S.code = res.code;
        S.session = { pid: res.playerId, token: res.token, nickname: res.nickname };
        store.set(sessionKey(S.code), S.session);
        store.set('sv:player:last', S.code);
        history.replaceState(null, '', `/play?code=${S.code}`);
        startGame();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Join game →';
      }
    });
    stage.replaceChildren(h('div', { class: 'card', style: { maxWidth: '520px', margin: '0 auto' } },
      h('h1', {}, 'Join a game'),
      h('p', {}, 'Enter the code from the host’s screen and pick a name.'),
      message ? h('div', { class: 'banner' }, message) : null,
      form));
    (S.code ? name : code).focus();
  }

  // ------------------------------------------------------------ connection
  function startGame() {
    $('#code-pill').textContent = `Game ${S.code}`;
    $('#me-pill').textContent = S.session.nickname;
    for (const id of ['code-pill', 'me-pill', 'conn', 'leave']) $(`#${id}`).hidden = false;
    stage.replaceChildren(h('div', { class: 'card center' }, h('p', {}, 'Connecting…')));
    S.conn = SV.connect({ code: S.code, role: 'player', pid: S.session.pid, token: S.session.token }, {
      onState,
      onStatus: SV.statusDot,
      onEnd: async (code) => {
        if (code === 4001) return leave('The host removed you from this game.');
        if (code === 4000) return leave('This game has ended.');
        const info = await api(`/api/games/${S.code}`).catch(() => null);
        if (info && !info.exists) return leave('That game no longer exists.');
        $('#notice').textContent = 'Having trouble reaching the game — still trying…';
        $('#notice').hidden = false;
      },
    });
  }

  function leave(message) {
    S.conn?.close();
    store.del(sessionKey(S.code));
    S.session = null;
    $('#notice').hidden = true;
    showJoin(message);
  }
  $('#leave').addEventListener('click', () => {
    if (confirm('Leave this game? Your points stay on the scoreboard, but you’ll need to rejoin with a new name.')) leave();
  });

  // ------------------------------------------------------------ state
  function onState(s) {
    $('#notice').hidden = true;
    const prev = S.state;
    S.state = s;
    if (prev && prev.phase !== 'results' && s.phase === 'results') S.prevScores = new Map(prev.players.map((p) => [p.id, p.score]));
    if (s.phase !== 'results') S.prevScores = null;

    $('#side').hidden = s.phase === 'lobby';
    $('#stage').parentElement.classList.toggle('solo', s.phase === 'lobby');
    $('#board-note').hidden = !s.scoresHidden;
    renderBoard($('#board'), s.players, { meId: s.me?.id, hidden: s.scoresHidden, prevScores: S.prevScores });

    const key = `${s.phase}:${s.round}`;
    if (key !== S.key) { S.key = key; S.ui = {}; mount[s.phase]?.(s); }
    update[s.phase]?.(s);
  }

  const mount = {};
  const update = {};

  // ---- lobby
  mount.lobby = (s) => {
    S.ui.chips = h('div', { class: 'chips' });
    stage.replaceChildren(h('div', { class: 'card center' },
      h('span', { class: 'pill green' }, 'You’re in!'),
      h('h1', { style: { marginTop: '12px' } }, `Hey ${s.me?.nickname || ''} 👋`),
      h('p', {}, `Waiting for ${s.hostName || 'the host'} to start. Keep this page open — when a round begins you get a task and a timer.`)),
      h('div', { class: 'card' }, h('h3', {}, 'Who’s here'), S.ui.chips));
  };
  update.lobby = (s) => {
    S.ui.chips.replaceChildren(...s.players.map((p) => h('span', { class: `chip${p.online ? '' : ' offline'}` }, h('span', { class: 'status' }), p.nickname, p.id === s.me?.id ? ' (you)' : '')));
  };

  // ---- submit
  mount.submit = (s) => {
    const ui = S.ui;
    ui.timer = timerRing();
    ui.progress = h('span', { class: 'pill' });
    ui.cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    ui.pickInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
    ui.preview = h('img', { class: 'preview', alt: 'Your photo', hidden: true });
    ui.status = h('p', { class: 'muted center', hidden: true });
    ui.bar = h('div', { class: 'progress', hidden: true }, h('span'));
    ui.submit = h('button', { class: 'btn primary block big', type: 'button', disabled: true }, 'Submit photo');
    ui.chooser = h('div', { class: 'stack' },
      ui.preview,
      h('div', { class: 'upload-actions' },
        h('button', { class: 'btn big', type: 'button', onclick: () => ui.cameraInput.click() }, '📷 Take photo'),
        h('button', { class: 'btn big', type: 'button', onclick: () => ui.pickInput.click() }, '🖼️ Choose photo')),
      ui.status, ui.bar, ui.submit, ui.cameraInput, ui.pickInput);
    ui.done = h('div', { class: 'done-box', hidden: true },
      h('div', { class: 'big-emoji' }, '✅'),
      h('h2', {}, 'Photo in!'),
      h('p', {}, 'Waiting for the others. You can still swap it until the timer runs out.'),
      h('button', { class: 'btn', type: 'button', onclick: () => { ui.replacing = true; paintSubmit(S.state); } }, 'Replace my photo'));
    ui.late = h('div', { class: 'done-box', hidden: true }, h('div', { class: 'big-emoji' }, '⏰'), h('h2', {}, 'Time’s up'), h('p', {}, 'Photos are being collected — voting starts in a moment.'));

    const onFile = async (input) => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      ui.submit.disabled = true;
      ui.status.hidden = false;
      ui.status.textContent = 'Preparing photo…';
      try {
        ui.blob = await SV.compressImage(file);
        if (ui.previewUrl) URL.revokeObjectURL(ui.previewUrl);
        ui.previewUrl = URL.createObjectURL(ui.blob);
        ui.preview.src = ui.previewUrl;
        ui.preview.hidden = false;
        ui.status.textContent = `Ready — ${SV.fmtBytes(ui.blob.size)}. Tap submit!`;
        ui.submit.disabled = false;
      } catch (err) {
        ui.status.textContent = err.message;
        toast(err.message, 'error');
      }
    };
    ui.cameraInput.addEventListener('change', () => onFile(ui.cameraInput));
    ui.pickInput.addEventListener('change', () => onFile(ui.pickInput));
    ui.submit.addEventListener('click', async () => {
      if (!ui.blob) return;
      ui.submit.disabled = true;
      ui.submit.textContent = 'Uploading…';
      ui.bar.hidden = false;
      try {
        await SV.uploadPhoto(`/api/games/${S.code}/photo`, ui.blob, {
          'X-Player-Id': S.session.pid, 'X-Player-Token': S.session.token, 'X-Round': String(S.state.round),
        }, (f) => { ui.bar.firstChild.style.width = `${Math.round(f * 100)}%`; });
        ui.replacing = false;
        ui.localDone = true;
        toast('Photo submitted!');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        ui.submit.textContent = 'Submit photo';
        ui.submit.disabled = !ui.blob;
        ui.bar.hidden = true;
        ui.bar.firstChild.style.width = '0';
        paintSubmit(S.state);
      }
    });

    const example = s.exampleUrl ? h('img', { class: 'example', src: s.exampleUrl, alt: 'Example photo from the host', onclick: () => SV.openLightbox(s.exampleUrl, 'Example') }) : null;
    stage.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('span', { class: 'pill pink' }, `Round ${s.round} / ${s.totalRounds}`), ui.progress),
      h('div', { class: 'task' }, h('div', { class: 'label' }, 'Your task'), h('h2', {}, s.task), example, h('p', { class: 'faint', style: { marginTop: '8px' } }, `${s.points} points per vote`)),
      ui.timer, ui.chooser, ui.done, ui.late));
    bindTimer(ui.timer, s.deadline, (s.deadline - SV.serverNow()));
    clearInterval(ui.lateTick);
    ui.lateTick = setInterval(() => { if (S.state?.phase === 'submit') paintSubmit(S.state); else clearInterval(ui.lateTick); }, 500);
  };
  function paintSubmit(s) {
    const ui = S.ui;
    if (!ui.chooser) return;
    const submitted = Boolean(s.me?.submitted || ui.localDone);
    const late = SV.serverNow() > s.deadline;
    ui.done.hidden = !submitted || ui.replacing || late;
    ui.chooser.hidden = (submitted && !ui.replacing) || late;
    ui.late.hidden = !late;
    if (late && submitted) ui.late.querySelector('h2').textContent = 'Photo in — voting starts in a moment';
  }
  update.submit = (s) => {
    S.ui.progress.textContent = `${s.progress.done} / ${s.progress.total} photos in`;
    if (s.me?.submitted) S.ui.localDone = true;
    paintSubmit(s);
  };

  // ---- vote
  mount.vote = (s) => {
    const ui = S.ui;
    ui.selected = [...(s.me?.votes || [])];
    ui.locked = Boolean(s.me?.locked);
    ui.timer = timerRing();
    ui.progress = h('span', { class: 'pill' });
    ui.count = h('span', { class: 'pill gold' });
    ui.lockBtn = h('button', { class: 'btn primary block big', type: 'button' });
    ui.lockedBox = h('div', { class: 'done-box', hidden: true }, h('div', { class: 'big-emoji' }, '🗳️'), h('h2', {}, 'Votes locked in'), h('p', {}, 'Results appear when everyone’s done or the timer runs out.'),
      h('button', { class: 'btn', type: 'button', onclick: () => sendVotes(false) }, 'Change my votes'));
    ui.tiles = new Map();
    const grid = h('div', { class: 'grid' }, s.gallery.map((img, i) => {
      const tile = h('button', { class: 'tile', type: 'button', 'aria-pressed': 'false', 'aria-label': `Photo ${i + 1}`, onclick: () => toggle(img.id) },
        h('img', { src: img.url, alt: `Photo ${i + 1}`, loading: 'lazy', decoding: 'async' }),
        h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'),
        h('span', { class: 'zoom', role: 'button', tabindex: '-1', 'aria-label': 'Enlarge', onclick: (e) => { e.stopPropagation(); SV.openLightbox(img.url, `Photo ${i + 1}`); } }, '⤢'));
      ui.tiles.set(img.id, tile);
      return tile;
    }));
    ui.voting = h('div', { class: 'stack' }, h('p', { class: 'muted center' }, 'Tap up to 3 favourites (yours isn’t shown). Tap ⤢ to see a photo bigger.'), grid, ui.lockBtn);
    ui.cannot = h('div', { class: 'done-box' }, h('div', { class: 'big-emoji' }, '🍿'), h('h2', {}, 'Sit back this round'), h('p', {}, 'There’s nothing for you to vote on — yours is the only photo. Results are coming up.'));
    ui.lockBtn.addEventListener('click', () => sendVotes(true));
    stage.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('span', { class: 'pill pink' }, `Round ${s.round} — voting`), h('span', { class: 'row' }, ui.count, ui.progress)),
      h('div', { class: 'task' }, h('div', { class: 'label' }, 'The task was'), h('h2', { style: { fontSize: '1.4rem' } }, s.task)),
      ui.timer,
      s.me?.canVote === false ? ui.cannot : h('div', {}, ui.voting, ui.lockedBox)));
    bindTimer(ui.timer, s.deadline, s.deadline - SV.serverNow());
    paintVotes();
  };
  function toggle(id) {
    const ui = S.ui;
    if (ui.locked) return;
    if (ui.selected.includes(id)) ui.selected = ui.selected.filter((x) => x !== id);
    else if (ui.selected.length >= 3) return toast('You have 3 votes — tap one to take it back.', 'error');
    else ui.selected.push(id);
    paintVotes();
    clearTimeout(ui.debounce);
    ui.debounce = setTimeout(() => { ui.debounce = null; S.conn.send({ t: 'vote', targets: ui.selected, lock: false }); }, 250);
  }
  function sendVotes(lock) {
    const ui = S.ui;
    clearTimeout(ui.debounce);
    ui.debounce = null;
    if (S.conn.send({ t: 'vote', targets: ui.selected, lock })) { ui.locked = lock; paintVotes(); }
  }
  function paintVotes() {
    const ui = S.ui;
    if (!ui.tiles) return;
    for (const [id, tile] of ui.tiles) {
      const on = ui.selected.includes(id);
      tile.classList.toggle('selected', on);
      tile.setAttribute('aria-pressed', String(on));
    }
    ui.count.textContent = `${ui.selected.length} / 3 votes`;
    ui.lockBtn.textContent = ui.selected.length ? `Lock in ${ui.selected.length} vote${ui.selected.length === 1 ? '' : 's'}` : 'Skip — no votes';
    if (ui.voting) ui.voting.hidden = ui.locked;
    ui.lockedBox.hidden = !ui.locked;
  }
  update.vote = (s) => {
    S.ui.progress.textContent = `${s.progress.done} / ${s.progress.total} voted`;
    if (s.me && s.me.locked !== S.ui.locked && !S.ui.debounce) { S.ui.locked = s.me.locked; paintVotes(); }
  };

  // ---- results
  mount.results = (s) => {
    const mine = s.results.find((r) => r.mine);
    stage.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('span', { class: 'pill green' }, `Round ${s.round} / ${s.totalRounds} — results`)),
      h('div', { class: 'task' }, h('h2', { style: { fontSize: '1.4rem' } }, s.task)),
      mine
        ? h('p', { class: 'center' }, h('span', { class: 'pill gold', style: { fontSize: '1rem' } }, `Your photo: ${mine.votes} vote${mine.votes === 1 ? '' : 's'} → +${mine.points} points`))
        : h('p', { class: 'center muted' }, 'You didn’t send a photo this round.'),
      resultsGrid(s.results),
      h('p', { class: 'center faint', style: { marginTop: '16px' } }, s.isLastRound ? 'Last round done — the ceremony is next! 🏆' : 'Next round starts when the host is ready.')));
  };

  // ---- ceremony
  mount.ceremony = (s) => {
    const box = h('div');
    S.ui.ceremony = createCeremony(box, { meId: s.me?.id });
    S.ui.waiting = h('p', { class: 'muted' });
    stage.replaceChildren(h('div', { class: 'card stage' }, h('div', { class: 'trophy' }, '🏆'), h('h1', {}, 'The final ceremony'), S.ui.waiting, box));
  };
  update.ceremony = (s) => {
    const c = s.ceremony;
    S.ui.waiting.textContent = c.revealed === 0 ? 'Eyes on the big screen… the top places are revealed one by one.' : c.revealed < c.total ? 'Who’s next?' : 'Thanks for playing! 📸';
    S.ui.ceremony.render(c);
  };

  // ------------------------------------------------------------ boot
  if (!S.code) {
    const last = store.get('sv:player:last');
    if (last && store.get(sessionKey(last))) S.code = last;
  }
  const saved = S.code ? store.get(sessionKey(S.code)) : null;
  if (saved?.pid && saved?.token) { S.session = saved; startGame(); }
  else showJoin();
})();
