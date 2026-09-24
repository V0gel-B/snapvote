(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const admin = params.get('admin') === '1';
  // Only allow same-site relative targets (no open redirects to other sites).
  const rawNext = params.get('next') || '';
  const next = /^\/(?!\/)[^\\]*$/.test(rawNext) ? rawNext : (admin ? '/host' : '/play');

  const $ = (id) => document.getElementById(id);
  if (admin) {
    document.title = 'SnapVote — Host login';
    $('title').textContent = 'Host login';
    $('subtitle').textContent = 'Hosting games and the admin panel need the admin password (not the one you give players).';
    $('pw-label').textContent = 'Admin password';
    $('switch').innerHTML = '';
    const a = document.createElement('a');
    a.href = '/play';
    a.textContent = 'Just want to play? Join a game instead';
    $('switch').append(a);
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('password').value;
    if (!password) return;
    const btn = $('submit');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    $('error').hidden = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, kind: admin ? 'admin' : 'site' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not log in.');
      location.replace(next);
    } catch (err) {
      $('error').textContent = err.message;
      $('error').hidden = false;
      $('password').select();
      btn.disabled = false;
      btn.textContent = 'Unlock →';
    }
  });
})();
