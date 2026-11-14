// Token Radar dashboard. Renders ONLY window.RADAR, written by main.ts
// from the sealed snapshot. No network, no fetch, no invented rows: if the
// data is missing the page shows an empty state.
(function () {
  'use strict';

  var DATA = window.RADAR || null;
  var app = document.getElementById('app');
  var modalRoot = document.getElementById('modal-root');
  var state = { q: '', chain: 'all', category: 'all', gas: 'all', sort: 'implied', dir: -1, watch: false, selected: null };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtNum(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtGas(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (n < 10) return '$' + n.toFixed(2);
    return fmtUsd(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var p = new URLSearchParams(hash);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('gas')) state.gas = p.get('gas');
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('watch') === '1') state.watch = true;
    if (p.get('p')) state.selected = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.gas !== 'all') p.set('gas', state.gas);
    if (state.sort !== 'implied') p.set('sort', state.sort);
    if (state.watch) p.set('watch', '1');
    if (state.selected) p.set('p', state.selected);
    var next = p.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function gasTierOf(row) {
    if (row.gas.gas_30d_usd < 1) return 'ultra';
    if (row.gas.gas_30d_usd <= 15) return 'moderate';
    return 'heavy';
  }
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.gas !== 'all' && gasTierOf(r) !== state.gas) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'gas') { av = a.gas.gas_30d_usd; bv = b.gas.gas_30d_usd; }
      else if (key === 'efficiency') { av = a.gas.ev_gas_multiple === null ? -Infinity : a.gas.ev_gas_multiple; bv = b.gas.ev_gas_multiple === null ? -Infinity : b.gas.ev_gas_multiple; }
      else if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'category') { av = (a.category || 'Other').toLowerCase(); bv = (b.category || 'Other').toLowerCase(); }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ---- static shell -------------------------------------------------------
  function header() {
    return el('header', { class: 'panel top' },
      el('div', { class: 'brand' },
        el('div', { class: 'scope' }, el('span', { class: 'blip' })),
        el('div', null,
          el('h1', null, 'TOKEN RADAR', el('span', { class: 'live', text: DATA.board_size + ' / ' + DATA.pre_token_size + ' PRE-TOKEN CANDIDATES LOCKED' })),
          el('p', { class: 'sub', text: 'Launch candidates only, ranked by what each token would be worth if the record stayed as it is. Snapshot ' + DATA.as_of + '.' })
        )
      ),
      el('div', { class: 'formula-pill' },
        'Est. FDV = Size-Fit Value \u00D7 7d Growth Mult \u00D7 Age Maturity Mult',
        el('br'),
        el('b', { text: 'Leave-one-out backtest on ' + DATA.backtest.tested + ' listed protocols: median error ' + DATA.backtest.mdape_pct.toFixed(2) + '% \u00B7 previous model ' + DATA.backtest.previous_mdape_pct.toFixed(2) + '%' })
      )
    );
  }

  function methodPanel() {
    var c = DATA.comps;
    var u = DATA.universe;
    var f = DATA.fit;
    var cells = [
      ['Universe', 'Launch candidates only: ' + DATA.board_size + ' of ' + DATA.pre_token_size + ' pre-token protocols. ' + u.excluded_categories.join(', ') + ' are out: venues and asset movers whose tokens already exist, or claims on existing assets. Of the rest, a protocol qualifies when its category holds at least ' + u.min_category_comps + ' live comps, when it sits on the watchlist, or when its TVL is at least ' + fmtUsd(u.min_tvl_usd) + '. All ' + DATA.watchlist_size + ' watchlist protocols are on the board.'],
      ['Size fit', 'log(market cap) = ' + f.global_intercept.toFixed(4) + ' + ' + f.global_slope.toFixed(4) + ' \u00D7 log(TVL), fitted on ' + c.pool_size + ' live-token protocols across ' + c.categories_with_comps + ' categories with robust Huber weights, so one outsized listing cannot bend the line. A slope under 1 means value grows slower than TVL.'],
      ['Category blend', 'A category with at least ' + DATA.config.category_line_min_comps + ' comps gets its own fitted line, blended with the global line at weight n/(n+' + DATA.config.blend_shrink_k + ') on the category. Below that, the global line stands plus the category\u2019s median residual, shrunk by the same weight. ' + f.line_categories + ' categories carry their own line; ' + f.offset_categories + ' ride the global line with an offset.'],
      ['Backtest', 'Leave-one-out on all ' + DATA.backtest.tested + ' listed protocols: each market cap is predicted from a fit that excludes it, growth and maturity left out. Median error ' + DATA.backtest.mdape_pct.toFixed(2) + '%, median signed error ' + fmtPct(DATA.backtest.median_signed_pct) + '. The previous model, category median multiples, posted a median error of ' + DATA.backtest.previous_mdape_pct.toFixed(2) + '%.'],
      ['Growth', '1 + clamp(7-day TVL change, \u221250%, +100%) / 100 \u00D7 ' + DATA.config.growth_weight + '. A missing 7-day change counts as no growth (multiplier 1).'],
      ['Maturity', '0.70 + 0.50 \u00D7 min(age in days, 1460) / 1460. A protocol with no listing date uses 0.95: no bonus, no penalty beyond it.'],
      ['Own claims', 'Implied values, airdrop pools and per-wallet figures are this board\u2019s own claims, never prices or promises. Airdrop pool: 15% of implied value for Dexs / Lending / Yield, 5% for CEX / Bridge, 10% otherwise. Per-wallet divides the pool by a rough active-wallet count by TVL tier (15k\u2013250k).']
    ];
    return el('details', { class: 'method panel' },
      el('summary', { text: 'Methodology & Calibration \u2014 how each number is earned' }),
      el('div', { class: 'grid' }, cells.map(function (pair) {
        return el('div', { class: 'cell' }, el('b', { text: pair[0] }), document.createTextNode(pair[1]));
      }))
    );
  }

  function kpiGrid(list) {
    var totalFdv = list.reduce(function (a, r) { return a + r.implied_value_usd; }, 0);
    var totalPool = list.reduce(function (a, r) { return a + r.airdrop.pool_usd; }, 0);
    var totalTvl = list.reduce(function (a, r) { return a + r.tvl_usd; }, 0);
    var avgMult = list.length ? list.reduce(function (a, r) { return a + r.model.fitted_multiple; }, 0) / list.length : 0;
    var cheap = list.filter(function (r) { return r.gas.cost_per_tx_usd < 0.5; }).length;
    return el('section', { class: 'kpis' },
      el('div', { class: 'panel kpi' }, el('div', { class: 'lab', text: 'Pre-token on this board' }), el('div', { class: 'val', html: esc(String(list.length)) + ' <small>/ ' + DATA.board_size + '</small>' }), el('div', { class: 'sub', text: 'of ' + DATA.total_protocols + ' protocols scanned \u00B7 ' + DATA.watchlist_size + ' on the watchlist' })),
      el('div', { class: 'panel kpi cyn' }, el('div', { class: 'lab', text: 'Aggregate est. pre-token FDV' }), el('div', { class: 'val', text: fmtUsd(totalFdv) }), el('div', { class: 'sub', text: 'Est. airdrop pool in view: ' + fmtUsd(totalPool) })),
      el('div', { class: 'panel kpi' }, el('div', { class: 'lab', text: 'Tracked pre-token TVL' }), el('div', { class: 'val', text: fmtUsd(totalTvl) }), el('div', { class: 'sub', text: 'Avg fitted multiple in view: ' + avgMult.toFixed(2) + 'x' })),
      el('div', { class: 'panel kpi amb' }, el('div', { class: 'lab', text: 'High-efficiency targets' }), el('div', { class: 'val', text: String(cheap) }), el('div', { class: 'sub', text: 'Gas under $0.50 a transaction \u00B7 best EV-to-gas first' }))
    );
  }

  var kpiSlot, metaSlot, tableSlot;

  function controls() {
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    function opt(v, label, cur) { return el('option', { value: v, text: label, selected: v === cur ? 'selected' : null }); }
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); update(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by primary chain' },
      opt('all', 'All chains', state.chain),
      chains.map(function (c) { return opt(c, c, state.chain); }));
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); update(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by sector' },
      opt('all', 'All sectors', state.category),
      cats.map(function (c) { return opt(c, c, state.category); }));
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); update(); });
    var gasSel = el('select', { id: 'gas', 'aria-label': 'Filter by gas tier' },
      opt('all', 'All gas tiers', state.gas),
      opt('ultra', 'Ultra-Low < $1 / 30d', state.gas),
      opt('moderate', 'Moderate $1\u201315 / 30d', state.gas),
      opt('heavy', 'Mainnet Heavy > $15 / 30d', state.gas));
    gasSel.addEventListener('change', function () { state.gas = gasSel.value; writeHash(); update(); });
    var sortSel = el('select', { id: 'sort', 'aria-label': 'Sort the board' },
      opt('implied', 'Est. FDV', state.sort),
      opt('tvl', 'TVL', state.sort),
      opt('growth', '7d Growth', state.sort),
      opt('efficiency', 'EV / Gas Efficiency', state.sort),
      opt('age', 'Age', state.sort),
      opt('gas', '30d Gas (low first)', state.sort));
    sortSel.addEventListener('change', function () { state.sort = sortSel.value; state.dir = state.sort === 'gas' ? 1 : -1; writeHash(); update(); });
    var watchBox = el('input', { type: 'checkbox', id: 'watch', checked: state.watch ? 'checked' : null });
    watchBox.addEventListener('change', function () { state.watch = watchBox.checked; writeHash(); update(); });
    var reset = el('button', { class: 'btn primary', type: 'button', text: 'RESET' });
    reset.addEventListener('click', function () {
      state.q = ''; state.chain = 'all'; state.category = 'all'; state.gas = 'all'; state.sort = 'implied'; state.dir = -1; state.watch = false;
      search.value = ''; chainSel.value = 'all'; catSel.value = 'all'; gasSel.value = 'all'; sortSel.value = 'implied'; watchBox.checked = false;
      writeHash(); update();
    });
    function field(label, forId, node) { return el('div', { class: 'field' }, el('label', { for: forId, text: label }), node); }
    return el('section', { class: 'panel controls' },
      field('Target Search', 'q', search),
      field('Primary Chain', 'chain', chainSel),
      field('Sector', 'category', catSel),
      field('Gas Tier', 'gas', gasSel),
      field('Sort', 'sort', sortSel),
      el('label', { class: 'check' }, watchBox, document.createTextNode(' Watchlist only')),
      reset
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'gas' ? 1 : -1; } writeHash(); update(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25BC' : ' \u25B2' }) : null
      )
    );
  }

  function gasPill(row) {
    var t = gasTierOf(row);
    var cls = t === 'ultra' ? 'low' : t === 'moderate' ? 'med' : 'high';
    return el('span', { class: 'gas-pill ' + cls, text: fmtGas(row.gas.gas_30d_usd) + ' / 30d' });
  }

  function boardTable(list) {
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { class: 'muted', text: 'Clear the search or pick another chain, sector or gas tier to see the board again.' })
      ));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var chainsShown = (r.chains || []).slice(0, 2).join(', ') + ((r.chains || []).length > 2 ? ' +' + ((r.chains || []).length - 2) : '');
      var tr = el('tr', {
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', null, el('span', { class: 'rank-badge' + (r.rank <= 25 ? ' top' : ''), text: '#' + r.rank })),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name + (r.watchlist ? ' \u2605' : '') }),
          el('span', { class: 'sub', text: 'Age: ' + fmtAge(r.age_days) + ' \u00B7 Fit: ' + r.model.fitted_multiple.toFixed(2) + 'x' })
        )),
        el('td', null, el('span', { class: 'tag chain', text: chainsShown || 'n/a' })),
        el('td', null, el('span', { class: 'tag sector', text: r.category || 'Other' })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', html: '<b style="color:var(--grn)">' + esc(fmtUsd(r.implied_value_usd)) + '</b>' }),
        el('td', null, gasPill(r)),
        el('td', null, el('span', { class: 'farm-preview', text: r.farm_steps[0] || '' })),
        el('td', null, el('button', { class: 'audit-btn', type: 'button', text: 'MATH & PLAN' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board-table' },
          el('caption', { class: 'muted', text: 'Pre-token launch candidates, strongest implied value first. Select a row for its fit math and farming plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            el('th', { scope: 'col', text: 'Chain' }),
            sortHeader('category', 'Sector'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('implied', 'Est. Token FDV'),
            sortHeader('gas', '30d Gas'),
            el('th', { scope: 'col', text: 'Concrete Farming Action' }),
            el('th', { scope: 'col', text: 'Audit' })
          )),
          tbody
        )
      )
    );
  }

  function liveSection() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('b', { text: r.name })),
        el('td', null, el('span', { class: 'tag sector', text: r.category || 'Other' })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.ratio.toFixed(4) + 'x' })
      ));
    });
    return el('section', { class: 'panel live-table' },
      el('h3', { class: 'mono', text: 'COMPS EVIDENCE \u2014 TOP 24 LIVE-TOKEN PROTOCOLS BY MARKET CAP' }),
      el('p', { class: 'sub', text: 'These protocols already trade. The size fit is fitted on their market caps and TVLs \u2014 the market\u2019s own values, set apart from the pre-token ranking.' }),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'Sector' }),
            el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }))),
          tbody
        )
      )
    );
  }

  // ---- detail modal -------------------------------------------------------
  var dialog = null;
  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    if (!dialog) {
      dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
      dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
      modalRoot.appendChild(dialog);
    }
    dialog.textContent = '';
    var m = row.model;
    var eff = row.gas.ev_gas_multiple;
    var effText = eff === null ? 'n/a' : eff < 3 ? 'low \u2014 about ' + eff + 'x gas' : '\u2248' + eff + 'x gas';
    var formula = el('div', { class: 'formula-bar' },
      el('div', { class: 'step' }, el('span', { class: 'lab', text: 'Current TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })),
      el('span', { class: 'op', text: '\u00D7' }),
      el('div', { class: 'step' }, el('span', { class: 'lab', text: 'Size-fit FDV / TVL' }), el('b', { text: m.fitted_multiple.toFixed(4) + 'x' }), el('span', { class: 'lab', text: m.fit_source === 'category' ? 'category line \u00B7 ' + m.comp_count + ' comps \u00B7 weight ' + m.fit_weight.toFixed(2) : 'global line \u00B7 ' + m.comp_count + ' category comps' })),
      el('span', { class: 'op', text: '\u00D7' }),
      el('div', { class: 'step' }, el('span', { class: 'lab', text: '7d Growth Mult' }), el('b', { text: m.growth_multiplier.toFixed(4) + 'x' })),
      el('span', { class: 'op', text: '\u00D7' }),
      el('div', { class: 'step' }, el('span', { class: 'lab', text: 'Age Maturity Mult' }), el('b', { text: m.maturity_multiplier.toFixed(4) + 'x' })),
      el('span', { class: 'op', text: '=' }),
      el('div', { class: 'step result' }, el('span', { class: 'lab', text: 'Est. Token FDV' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
    );
    var peers = el('div', { class: 'peers' }, m.peers.map(function (p) {
      return el('span', { class: 'peer' }, document.createTextNode(p.name + ' '), el('b', { text: p.ratio.toFixed(4) + 'x' }));
    }));
    if (m.floor_estimate) peers.appendChild(el('span', { class: 'peer', text: 'Floor estimate: no positive TVL on record, priced from the global fit at the category median TVL' }));
    var steps = el('ol', { class: 'steps' }, row.farm_steps.map(function (s, i) {
      return el('li', null, el('span', { class: 'step-no', text: 'STEP 0' + (i + 1) + ':' }), document.createTextNode(s));
    }));
    var body = el('div', { class: 'detail-body' },
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'rank-badge top', text: 'RANK #' + row.rank + ' OF ' + DATA.board_size }),
          el('h2', { id: 'detail-title', text: row.name }),
          el('p', { class: 'sub', text: (row.chains || []).join(' \u00B7 ') + ' \u00B7 ' + (row.category || 'Other') + ' \u00B7 Age: ' + fmtAge(row.age_days) + ' \u00B7 7d TVL ' + fmtPct(row.change_7d) + (row.watchlist ? ' \u00B7 on the watchlist' : '') })
        ),
        el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
      ),
      el('section', { class: 'sec' },
        el('h3', null, el('span', { text: '01 // ' }), document.createTextNode('Size-fit valuation breakdown')),
        el('span', { class: 'eff-badge', text: 'Est. airdrop pool (' + Math.round(row.airdrop.share_pct * 100) + '%): ' + fmtUsd(row.airdrop.pool_usd) }),
        formula,
        el('p', { class: 'sub', text: 'Listed peer comps in this category, the fit\u2019s own evidence:' }),
        peers,
        el('p', { class: 'note', text: 'Base ' + fmtNum(m.base_usd) + ' = the fitted value at this TVL, TVL \u00D7 ' + m.fitted_multiple.toFixed(4) + 'x. Per-wallet figure: ' + fmtUsd(row.airdrop.per_wallet_usd) + ' (pool \u00F7 ' + row.airdrop.wallets_assumed.toLocaleString('en-US') + ' assumed active wallets for this TVL tier \u2014 the board\u2019s own assumption, never a promise).' })
      ),
      el('section', { class: 'sec' },
        el('h3', null, el('span', { text: '02 // ' }), document.createTextNode('Concrete farming plan & chain gas telemetry')),
        el('span', { class: 'eff-badge', text: 'EV-to-gas: ' + effText }),
        el('div', { class: 'stats3' },
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Avg gas / tx \u00B7 ' + (row.chains[0] || 'main chain') }), el('div', { class: 'val', text: row.gas.cost_label })),
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Est. 30-day gas (' + row.gas.actions_per_week + ' actions / week)' }), el('div', { class: 'val', text: fmtGas(row.gas.gas_30d_usd) })),
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Recommended min capital' }), el('div', { class: 'val cyn', text: row.capital_range }))
        ),
        steps
      )
    );
    dialog.appendChild(body);
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  // ---- render -------------------------------------------------------------
  function update() {
    var list = sortedRows(filteredRows());
    kpiSlot.textContent = '';
    kpiSlot.appendChild(kpiGrid(list));
    metaSlot.textContent = '';
    metaSlot.appendChild(el('span', { text: 'Displaying ' + list.length + ' of ' + DATA.board_size + ' pre-token launch candidates' }));
    metaSlot.appendChild(el('span', { class: 'hint', text: 'Click any protocol row to inspect fit math & farming plan' }));
    tableSlot.textContent = '';
    tableSlot.appendChild(boardTable(list));
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'wrap' });
    shell.appendChild(header());
    shell.appendChild(methodPanel());
    kpiSlot = el('div');
    metaSlot = el('div', { class: 'meta' });
    tableSlot = el('div');
    shell.appendChild(kpiSlot);
    shell.appendChild(controls());
    shell.appendChild(metaSlot);
    shell.appendChild(tableSlot);
    shell.appendChild(liveSection());
    shell.appendChild(el('footer', { text: 'Token Radar ' + DATA.model_version + ' \u00B7 snapshot ' + DATA.as_of + ' \u00B7 ' + DATA.source + ' \u00B7 Implied values are this board\u2019s own claims.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    update();
    if (state.selected) openDetail(state.selected);
  }

  if (!DATA || !Array.isArray(DATA.rows) || DATA.rows.length === 0) {
    app.textContent = '';
    app.appendChild(el('div', { class: 'wrap' },
      el('div', { class: 'panel empty' },
        el('h2', { text: 'No board data loaded' }),
        el('p', { class: 'muted', text: 'This page renders only the data the program writes beside it as data.js. Run main.ts on the snapshot first.' })
      )));
    app.setAttribute('aria-busy', 'false');
    return;
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog && dialog.open) dialog.close();
  });
})();
