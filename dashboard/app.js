// Token Launch Radar — dashboard logic. Reads window.RADAR_DATA (written by
// main.ts from the sealed snapshot) and renders the board, filters, detail
// view and traded-token reference. No network: every byte comes from data.js.
(function () {
  'use strict';
  var D = window.RADAR_DATA;
  if (!D) { document.getElementById('metaLine').textContent = 'Data failed to load.'; return; }
  var rows = D.rows;
  var meta = D.meta;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function compact(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function full(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(c) {
    if (c === null || c === undefined) return '<span class="flat">—</span>';
    var cls = c > 0 ? 'up' : c < 0 ? 'down' : 'flat';
    var sign = c > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + c.toFixed(1) + '%</span>';
  }
  function ageLabel(days) {
    if (days >= 365) return (days / 365).toFixed(1) + ' yrs';
    if (days >= 30) return Math.round(days / 30) + ' mo';
    return days + ' days';
  }

  // ---- header + stats
  $('metaLine').textContent =
    'Snapshot ' + meta.as_of + ' · ' + meta.board_rows + ' launch candidates · ' +
    meta.watchlist_rows + ' on the watchlist (floor ' + compact(meta.floor_usd) + ') · ' +
    'Source: DefiLlama public protocols API';
  var statsHtml =
    stat('<b>' + meta.board_rows + '</b>', 'launch candidates ranked') +
    stat('<b>' + meta.watchlist_rows + '</b>', 'on the $50M watchlist') +
    stat('<b class="hot">' + compact(meta.total_implied_usd) + '</b>', 'total implied launch value') +
    stat('<b>' + meta.median_mcap_tvl.toFixed(2) + '×</b>', 'median mcap / TVL of traded tokens');
  function stat(b, label) { return '<div class="stat">' + b + '<span>' + label + '</span></div>'; }
  $('stats').innerHTML = statsHtml;

  // ---- filter controls
  var cats = [];
  var chains = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  cats.forEach(function (c) { $('cat').appendChild(opt(c, c)); });
  chains.forEach(function (c) { $('chain').appendChild(opt(c, c)); });
  function opt(v, label) {
    var o = document.createElement('option');
    o.value = v; o.textContent = label;
    return o;
  }

  // ---- state, from the URL so each view is linkable
  var params = new URLSearchParams(window.location.search);
  var state = {
    q: params.get('q') || '',
    cat: params.get('cat') || '',
    chain: params.get('chain') || '',
    minTvl: parseInt(params.get('minTvl') || '0', 10) || 0,
    sort: params.get('sort') || 'value',
    watchOnly: params.get('watchlist') === '1',
  };
  $('q').value = state.q;
  $('cat').value = state.cat;
  $('chain').value = state.chain;
  $('minTvl').value = String(state.minTvl);
  $('sort').value = state.sort;
  $('watchOnly').checked = state.watchOnly;

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (q && (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0)) return false;
      return true;
    });
    var by = {
      value: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      change: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      age: function (a, b) { return b.age_days - a.age_days; },
      name: function (a, b) { return a.name < b.name ? -1 : 1; },
    }[state.sort] || function (a, b) { return a.rank - b.rank; };
    return list.slice().sort(by);
  }

  function renderTable() {
    var list = filtered();
    var html = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><div class="pname">' + esc(r.name) + '</div><div class="pslug">' + esc(r.slug) + '</div></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + compact(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageLabel(r.age_days) + '</td>' +
        '<td class="num"><b>' + compact(r.implied_value_usd) + '</b></td>' +
        '<td><span class="badge pre">NO TOKEN RECORDED</span>' + (r.watchlist ? '<span class="badge watch">WATCHLIST</span>' : '') + '</td>' +
        '</tr>';
    }).join('');
    $('rows').innerHTML = html || '<tr><td colspan="9">No protocols match these filters.</td></tr>';
    $('count').textContent = list.length + ' of ' + rows.length + ' protocols';
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { showDetail(tr.getAttribute('data-slug'), true); });
    });
  }

  function bySlug(slug) {
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) return rows[i];
    return null;
  }

  function showDetail(slug, scroll, instant) {
    var r = bySlug(slug);
    if (!r) return;
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
      tr.classList.toggle('sel', tr.getAttribute('data-slug') === slug);
    });
    var m = r.model;
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var back = document.body.classList.contains('detail-mode')
      ? '<p class="backlink"><a href="#" id="backLink">&larr; Back to the full board</a></p>'
      : '';
    $('detail').innerHTML =
      back +
      '<h2>#' + r.rank + ' · ' + esc(r.name) + '</h2>' +
      '<p class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' +
      esc(r.chains.join(', ')) + ' · <span class="badge pre">NO TOKEN RECORDED</span>' +
      (r.watchlist ? '<span class="badge watch">WATCHLIST</span>' : '') + '</p>' +
      '<div class="dgrid">' +
      '<div><span>Implied value</span><b>' + full(r.implied_value_usd) + '</b></div>' +
      '<div><span>TVL</span><b>' + full(r.tvl_usd) + '</b></div>' +
      '<div><span>7-day TVL change</span><b>' + (r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + '</b></div>' +
      '<div><span>Running with no token</span><b>' + ageLabel(r.age_days) + '</b></div>' +
      '</div>' +
      '<table class="model"><tbody>' +
      '<tr><td>Base value — TVL × traded median mcap/TVL (' + m.multiple.toFixed(2) + '×)</td><td>' + full(m.base_value_usd) + '</td></tr>' +
      '<tr><td>× Growth factor — 7-day TVL change ' + (r.change_7d === null ? 'unreported' : r.change_7d.toFixed(2) + '%') + '</td><td>' + m.growth_factor.toFixed(2) + '×</td></tr>' +
      '<tr><td>× Age factor — ' + r.age_days + ' days with no token recorded</td><td>' + m.age_factor.toFixed(2) + '×</td></tr>' +
      '<tr><td>× Breadth factor — live on ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + '</td><td>' + m.breadth_factor.toFixed(2) + '×</td></tr>' +
      '<tr><td><strong>Implied launch value</strong></td><td><strong>' + full(r.implied_value_usd) + '</strong></td></tr>' +
      '</tbody></table>' +
      '<h2>How to farm it</h2>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p class="method">DefiLlama records no token for ' + esc(r.name) + '. That is what the record says — not proof the protocol has none, and not a prediction that it will issue one.</p>';
    try {
      history.replaceState(null, '', '#detail=' + encodeURIComponent(slug));
    } catch (e) { /* history unavailable */ }
    var backLink = $('backLink');
    if (backLink) {
      backLink.addEventListener('click', function (ev) {
        ev.preventDefault();
        document.body.classList.remove('detail-mode');
        try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* ignore */ }
        renderTable();
        window.scrollTo(0, 0);
      });
    }
    if (scroll) $('detail').scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
  }

  // ---- traded-token reference
  $('tradedRows').innerHTML = meta.traded_top.map(function (t) {
    return '<tr><td><b>' + esc(t.name) + '</b> <span class="pslug">' + esc(t.slug) + '</span></td>' +
      '<td class="num">' + compact(t.mcap_usd) + '</td>' +
      '<td class="num">' + compact(t.tvl_usd) + '</td>' +
      '<td class="num">' + t.ratio.toFixed(2) + '×</td></tr>';
  }).join('');
  $('methodLine').textContent =
    'Model: implied value = TVL × ' + meta.median_mcap_tvl.toFixed(2) +
    ' (median mcap/TVL of traded tokens in this snapshot) × growth × age × breadth. ' +
    'The board holds ' + meta.board_rows + ' protocols; the ' + meta.watchlist_rows +
    ' watchlist protocols are the floor, not the ceiling.';

  // ---- events
  $('q').addEventListener('input', function () { state.q = $('q').value; renderTable(); });
  $('cat').addEventListener('change', function () { state.cat = $('cat').value; renderTable(); });
  $('chain').addEventListener('change', function () { state.chain = $('chain').value; renderTable(); });
  $('minTvl').addEventListener('change', function () { state.minTvl = parseInt($('minTvl').value, 10) || 0; renderTable(); });
  $('sort').addEventListener('change', function () { state.sort = $('sort').value; renderTable(); });
  $('watchOnly').addEventListener('change', function () { state.watchOnly = $('watchOnly').checked; renderTable(); });

  renderTable();

  // Deep link: #detail=<slug> opens that protocol's detail view on load.
  var hash = window.location.hash || '';
  var m = /^#detail=(.+)$/.exec(hash);
  if (m) {
    document.body.classList.add('detail-mode');
    showDetail(decodeURIComponent(m[1]), false, true);
  }
})();
