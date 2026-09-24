/* Rendering pieces shared by the player and host screens (window.SVViews). */
(function () {
  'use strict';
  const { h } = window.SV;

  /** Scoreboard list. `hidden` = totals withheld until the ceremony. */
  function renderBoard(listEl, players, { meId, hidden, prevScores } = {}) {
    listEl.replaceChildren(
      ...players.map((p, i) => {
        const delta = !hidden && prevScores && prevScores.has(p.id) ? p.score - prevScores.get(p.id) : 0;
        return h('li', { class: [p.id === meId ? 'me' : '', !hidden && p.rank === 1 && p.score > 0 ? 'top' : ''].join(' ') },
          h('span', { class: 'rank' }, hidden || !p.score ? '–' : p.rank ?? i + 1),
          h('span', { class: 'name' }, p.nickname, p.id === meId ? ' (you)' : ''),
          delta > 0 ? h('span', { class: 'delta' }, `+${delta}`) : null,
          h('span', { class: 'score' }, hidden ? '' : p.score));
      }),
    );
  }

  /** Results grid: photos sorted by votes, names revealed. */
  function resultsGrid(results, { onRemove, large } = {}) {
    if (!results.length) return h('p', { class: 'muted center' }, 'No photos this round.');
    const best = results[0]?.votes || 0;
    return h('div', { class: `grid${large ? ' large' : ''}` },
      results.map((r) => h('div', { class: `tile${r.mine ? ' mine' : ''}${best > 0 && r.votes === best ? ' winner' : ''}` },
        h('img', { src: r.url, alt: `Photo by ${r.nickname}`, loading: 'lazy', decoding: 'async' }),
        onRemove && r.id ? h('button', { class: 'btn danger small remove', type: 'button', onclick: (e) => { e.stopPropagation(); onRemove(r); } }, 'Remove') : null,
        h('button', { class: 'zoom', type: 'button', 'aria-label': 'Enlarge photo', onclick: () => SV.openLightbox(r.url, `${r.nickname} · ${r.votes} vote${r.votes === 1 ? '' : 's'}`) }, '⤢'),
        h('div', { class: 'caption' },
          h('span', { class: 'name' }, best > 0 && r.votes === best ? h('span', { class: 'medal', 'aria-label': 'Most votes' }, '🥇') : null, r.mine ? `${r.nickname} (you)` : r.nickname),
          h('span', {}, `${r.votes} ♥${r.points ? ` · +${r.points}` : ''}`)))));
  }

  /**
   * Ceremony: revealed entries (best first). While the #1 drum-roll is
   * running, the winner stays hidden on every screen until `finaleAt`.
   */
  function createCeremony(container, { meId } = {}) {
    let shownIds = new Set();
    let finaleShownFor = null;
    let tick = null;

    function render(c) {
      const finaleRunning = c.finaleAt && SV.serverNow() < c.finaleAt;
      const complete = c.total > 0 && c.revealed >= c.total;
      const entries = c.entries.filter((e) => !(finaleRunning && complete && e.rank === 1));
      const list = h('ol', { class: 'podium' },
        entries.map((e) => {
          const fresh = !shownIds.has(e.id);
          return h('li', { class: `${e.rank === 1 ? 'first' : ''} ${e.id === meId ? 'me' : ''}`, style: fresh ? {} : { animation: 'none' } },
            h('span', { class: 'rank' }, e.rank === 1 ? '🏆' : `#${e.rank}`),
            h('span', { class: 'name' }, e.nickname, e.id === meId ? ' (you)' : ''),
            h('span', { class: 'score' }, `${e.score} pts`));
        }));
      shownIds = new Set(entries.map((e) => e.id));
      container.replaceChildren(list);

      if (complete && c.finaleAt && finaleShownFor !== c.finaleAt) {
        finaleShownFor = c.finaleAt;
        runFinale(c.entries.filter((e) => e.rank === 1), c.finaleAt, () => render(c));
      }
    }

    function runFinale(winners, at, onDone) {
      clearInterval(tick);
      const overlay = h('div', { class: 'finale', role: 'dialog', 'aria-live': 'assertive' });
      document.body.append(overlay);
      const paint = () => {
        const left = at - SV.serverNow();
        if (left > 0) {
          overlay.replaceChildren(h('div', {}, h('p', { class: 'drum' }, 'And the winner is…'), h('div', { class: 'count' }, Math.ceil(left / 1000))));
          return;
        }
        clearInterval(tick);
        const isMe = winners.some((w) => w.id === meId);
        const tie = winners.length > 1;
        overlay.replaceChildren(h('div', {},
          h('div', { class: 'trophy' }, '🏆'),
          tie ? h('p', { class: 'drum' }, 'It’s a tie!') : null,
          h('div', { class: 'winner' }, winners.map((w) => w.nickname).join(' & ')),
          h('p', { class: 'drum' }, isMe ? (tie ? 'You share the crown! 🎉' : 'That’s you! 🎉') : `${winners[0].score} points`),
          h('button', { class: 'btn primary', type: 'button', onclick: () => overlay.remove() }, 'Close')));
        window.confettiBurst?.({ count: 240 });
        setTimeout(() => window.confettiBurst?.({ count: 160, originY: window.innerHeight * 0.2 }), 450);
        setTimeout(() => window.confettiBurst?.({ count: 160, originX: window.innerWidth * 0.2 }), 900);
        onDone();
        setTimeout(() => overlay.remove(), 12000);
      };
      if (at - SV.serverNow() < -8000) { overlay.remove(); onDone(); return; } // joined long after: skip the show
      paint();
      tick = setInterval(paint, 150);
    }

    return { render };
  }

  window.SVViews = { renderBoard, resultsGrid, createCeremony };
})();
