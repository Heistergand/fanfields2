// Page d'administration des statistiques d'usage de Fan Fields 3
'use strict';

(function () {
  const TOKEN_KEY = 'fanfields-stats-admin-token';
  const REGION_LABELS = {
    other: 'Other / unknown',
    north_america: 'North America',
    south_america: 'South America',
    west_europe: 'West Europe',
    middle_east_africa: 'Middle East & Africa',
    east_europe: 'East Europe',
    china: 'China',
    asia: 'Asia'
  };
  const $ = function (id) { return document.getElementById(id); };

  let token = null;

  // localStorage (pas sessionStorage) : la session doit survivre à la fermeture du navigateur,
  // pour coller à la durée de 30 jours accordée côté serveur (voir SESSION_TTL).
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return token; }
  }
  function setToken(t) {
    token = t;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* stockage indisponible : jeton gardé en mémoire */ }
  }

  function api(route, body) {
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const t = getToken() || token;
    if (t) opts.headers.Authorization = 'Bearer ' + t;
    opts.body = JSON.stringify(body || {});
    return fetch('api/' + route, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (json) {
        if (r.status === 401 && route !== 'login') {
          setToken(null);
          showLogin();
        }
        if (!r.ok) {
          const err = new Error(json.error || ('HTTP ' + r.status));
          err.status = r.status;
          err.body = json;
          throw err;
        }
        return json;
      });
    });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function formatHours(seconds) {
    return (seconds / 3600).toFixed(1) + ' h';
  }
  function formatDay(day) {
    return new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2500);
  }

  // ---- Vues ----

  function showLogin() {
    $('mainView').hidden = true;
    $('nav').hidden = true;
    $('loginView').hidden = false;
    if ($('passwordDialog').open) $('passwordDialog').close();
    const input = $('loginForm').elements.user;
    if (!input.value) input.focus(); else $('loginForm').elements.password.focus();
  }

  function showMain() {
    $('loginView').hidden = true;
    $('mainView').hidden = false;
    $('nav').hidden = false;
    load();
  }

  function dateInputValue(d) { return d.toISOString().slice(0, 10); }

  function applyPreset(days) {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    $('from').value = dateInputValue(from);
    $('to').value = dateInputValue(to);
    load();
  }

  function renderStats(res) {
    const box = $('stats');
    box.textContent = '';
    [
      ['Active agents', String(res.totals.uniqueAgents)],
      ['Pings', String(res.totals.events)],
      ['Active time', formatHours(res.totals.seconds)]
    ].forEach(function (s) {
      const d = el('div', 'stat');
      d.appendChild(el('div', 'label', s[0]));
      d.appendChild(el('div', 'value', s[1]));
      box.appendChild(d);
    });
  }

  function renderHistory(byDay) {
    const box = $('history');
    box.textContent = '';
    if (!byDay.length) { box.appendChild(el('p', 'history-empty', 'No data for this range.')); return; }
    const max = byDay.reduce(function (m, d) { return Math.max(m, d.seconds); }, 0) || 1;
    byDay.forEach(function (d) {
      const bar = el('div', 'history-bar');
      bar.style.height = Math.max(2, (d.seconds / max) * 100) + '%';
      bar.title = formatDay(d.date) + ' : ' + formatHours(d.seconds) + ', ' + d.uniqueAgents + ' agent(s)';
      box.appendChild(bar);
    });
  }

  function renderBreakdown(containerId, rows, labelFor, cls) {
    const box = $(containerId);
    box.textContent = '';
    const max = rows.reduce(function (m, r) { return Math.max(m, r.seconds); }, 0) || 1;
    const any = rows.some(function (r) { return r.seconds > 0; });
    if (!any) { box.appendChild(el('p', 'muted', 'No data for this range.')); return; }
    rows.forEach(function (r) {
      if (r.seconds === 0 && r.uniqueAgents === 0) return;
      const row = el('div', 'breakdown-row' + (cls ? ' ' + cls(r) : ''));
      row.appendChild(el('div', null, labelFor(r)));
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = Math.max(2, (r.seconds / max) * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('div', 'muted', formatHours(r.seconds) + ' · ' + r.uniqueAgents + ' agent(s)'));
      box.appendChild(row);
    });
  }

  function load() {
    const body = {
      from: $('from').value,
      to: $('to').value,
      faction: $('faction').value,
      region: $('region').value
    };
    return api('stats', body).then(function (res) {
      $('whoami').textContent = res.admin.user;
      renderStats(res);
      renderHistory(res.byDay);
      renderBreakdown('byFaction', res.byFaction, function (r) { return r.faction === 'ENL' ? 'Enlightened' : 'Resistance'; },
        function (r) { return r.faction === 'ENL' ? 'enl' : 'res'; });
      renderBreakdown('byRegion', res.byRegion, function (r) { return REGION_LABELS[r.region] || r.region; });
    }).catch(function (e) {
      if (e.status !== 401) toast('Could not load stats: ' + e.message);
    });
  }

  // ---- Mot de passe admin ----

  function openPassword() {
    $('passwordForm').reset();
    $('passwordError').hidden = true;
    $('passwordDialog').showModal();
  }

  function submitPassword(ev) {
    ev.preventDefault();
    const f = ev.target.elements;
    const err = $('passwordError');
    const fail = function (msg) { err.textContent = msg; err.hidden = false; };
    if (f.password.value !== f.confirm.value) return fail('The new passwords do not match.');
    api('password', { current: f.current.value, password: f.password.value }).then(function () {
      $('passwordDialog').close();
      toast('Admin password changed');
    }).catch(function (e) {
      if (e.status === 403) fail('Current password is wrong.');
      else if (e.status === 429) fail('Too many attempts, try again later.');
      else if (e.body && e.body.error === 'weak password') fail('The new password must be at least ' + e.body.min + ' characters long.');
      else fail('Error: ' + e.message);
    });
  }

  // ---- Connexion ----

  function submitLogin(ev) {
    ev.preventDefault();
    const f = ev.target.elements;
    const err = $('loginError');
    err.hidden = true;
    api('login', { user: f.user.value.trim(), password: f.password.value }).then(function (res) {
      setToken(res.token);
      f.password.value = '';
      showMain();
    }).catch(function (e) {
      err.textContent = e.status === 429 ? 'Too many attempts, try again later.'
        : e.status === 401 ? 'Wrong user or password.' : 'Error: ' + e.message;
      err.hidden = false;
    });
  }

  function logout() {
    api('logout', {}).catch(function () { /* session déjà expirée */ }).then(function () {
      setToken(null);
      showLogin();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    Object.keys(REGION_LABELS).forEach(function (region) {
      const opt = el('option', null, REGION_LABELS[region]);
      opt.value = region;
      $('region').appendChild(opt);
    });

    applyPreset(30);

    $('loginForm').addEventListener('submit', submitLogin);
    $('passwordForm').addEventListener('submit', submitPassword);
    $('btnLogout').addEventListener('click', logout);
    $('btnPassword').addEventListener('click', openPassword);
    $('btnApply').addEventListener('click', load);
    document.querySelectorAll('#presets button').forEach(function (b) {
      b.addEventListener('click', function () { applyPreset(Number(b.dataset.days)); });
    });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { b.closest('dialog').close(); });
    });

    if (getToken()) showMain(); else showLogin();
  });
})();
