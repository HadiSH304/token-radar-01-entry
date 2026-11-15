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
  function fmtMinutes(min) {
    if (min === null || min === undefined || !isFinite(min)) return 'n/a';
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
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
      else if (key === 'ev') { av = a.airdrop.per_wallet_usd; bv = b.airdrop.per_wallet_usd; }
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
        'Est. FDV = exp(fit on log TVL + log age + category offset) \u00D7 calibration',
        el('br'),
        el('b', { text: 'Leave-one-out backtest on ' + DATA.backtest.tested + ' listed protocols: median error ' + DATA.backtest.mdape_pct.toFixed(2) + '% \u00B7 v2 ' + DATA.backtest.previous_mdape_pct.toFixed(2) + '% \u00B7 v1 ' + DATA.backtest.first_mdape_pct.toFixed(2) + '%' })
      )
    );
  }

  function methodPanel() {
    var c = DATA.comps;
    var u = DATA.universe;
    var f = DATA.fit;
    var coef = f.coefficients;
    var chosenCv = null;
    f.candidates.forEach(function (cand) { if (cand.chosen) chosenCv = cand.cv_mdape_pct; });
    var candLines = f.candidates.map(function (cand) {
      return cand.label + ' \u2014 CV ' + cand.cv_mdape_pct.toFixed(2) + '%' + (cand.chosen ? ' (chosen)' : '');
    }).join('; ');
    var cells = [
      ['Universe', 'Launch candidates only: ' + DATA.board_size + ' of ' + DATA.pre_token_size + ' pre-token protocols. ' + u.excluded_categories.join(', ') + ' are out: venues and asset movers whose tokens already exist, or claims on existing assets. Of the rest, a protocol qualifies when its category holds at least ' + u.min_category_comps + ' live comps, when it sits on the watchlist, or when its TVL is at least ' + fmtUsd(u.min_tvl_usd) + '. All ' + DATA.watchlist_size + ' watchlist protocols are on the board.'],
      ['Model selection', 'Eight candidate pipelines \u2014 feature set (log TVL alone, + log age, + age as a fraction of four years, + an age-missing flag) \u00D7 category shrinkage (k = 3, 4, 6) \u00D7 trimmed or untrimmed fit \u2014 are scored by 5-fold cross-validation on the ' + c.pool_size + ' listed protocols. A challenger replaces the default only when it scores better by more than ' + DATA.config.selection_margin_pct + ' points. On this snapshot the default stands: ' + f.chosen_label + (chosenCv !== null ? ', CV median error ' + chosenCv.toFixed(2) + '%' : '') + '. All eight scores: ' + candLines + '.'],
      ['The fit', 'log(market cap) is fitted on log TVL and the chosen age term with robust Huber weights, then refitted on the points inside 2.2 median-absolute-deviation sigmas \u2014 ' + f.trimmed_count + ' of ' + c.pool_size + ' comps sit outside and are trimmed as outsized. Fitted coefficients on this snapshot: ' + coef.log_tvl.toFixed(4) + ' per unit of log TVL' + (coef.age !== null && coef.age !== undefined ? ', ' + coef.age.toFixed(4) + ' per unit of the age term' : '') + ', around a centred intercept of ' + coef.intercept_at_pool_mean.toFixed(4) + ' (the prediction at the pool-average profile, before offsets and calibration).'],
      ['Category offsets', 'Each category adds its median residual to the global surface, shrunk by n/(n+' + f.cat_k + '): a category with 4 comps counts half its offset, one with 36 counts nine-tenths. ' + c.categories_with_comps + ' categories carry an offset; a protocol in a category with no listed comps prices off the global surface alone.'],
      ['Calibration', 'A constant multiplier of ' + f.calibration_factor.toFixed(4) + ' is applied to every fitted value: the log-space shift that zeroes the median signed percentage error of the pipeline\u2019s own out-of-fold predictions on the listed protocols. It corrects the small systematic tilt a trimmed fit leaves behind.'],
      ['Backtest', 'Leave-one-out on all ' + DATA.backtest.tested + ' listed protocols: each market cap is predicted by the full procedure \u2014 selection, calibration, fit \u2014 run without it. Median error ' + DATA.backtest.mdape_pct.toFixed(2) + '%, median signed error ' + fmtPct(DATA.backtest.median_signed_pct) + '. The previous models scored worse on the same grade: v2 size fit ' + DATA.backtest.previous_mdape_pct.toFixed(2) + '%, v1 category medians ' + DATA.backtest.first_mdape_pct.toFixed(2) + '%.'],
      ['Tested and rejected', 'Two snapshot fields are not in the price, because cross-validation scored them worse during development: 7-day TVL growth and chain count. Both still show on the board as data \u2014 the growth column and the chain tags \u2014 but neither moves a fitted value.'],
      ['Own claims', 'Implied values, airdrop pools and per-wallet figures are this board\u2019s own claims, never prices or promises. Airdrop pool: 15% of implied value for Dexs / Lending / Yield, 5% for CEX / Bridge, 10% otherwise \u2014 the 5\u201315% band each farm plan states. Per-wallet divides the pool by a rough active-wallet count by TVL tier (15k\u2013250k).']
    ];
    return el('details', { class: 'method panel' },
      el('summary', { text: 'Methodology & Calibration \u2014 how each number is earned' }),
      el('div', { class: 'grid' }, cells.map(function (pair) {
        return el('div', { class: 'cell' }, el('b', { text: pair[0] }), document.createTextNode(pair[1]));
      }))
    );
  }

  function sectorPanel() {
    var byCat = {};
    DATA.rows.forEach(function (r) {
      var key = r.category || 'Other';
      if (!byCat[key]) byCat[key] = { count: 0, fdv: 0, pool: 0 };
      byCat[key].count += 1;
      byCat[key].fdv += r.implied_value_usd;
      byCat[key].pool += r.airdrop.pool_usd;
    });
    var cats = Object.keys(byCat).map(function (k) { return { name: k, count: byCat[k].count, fdv: byCat[k].fdv, pool: byCat[k].pool }; });
    cats.sort(function (a, b) { return b.fdv - a.fdv; });
    var top = cats.slice(0, 10);
    if (cats.length > 10) {
      var rest = { name: 'All other sectors', count: 0, fdv: 0, pool: 0 };
      cats.slice(10).forEach(function (c) { rest.count += c.count; rest.fdv += c.fdv; rest.pool += c.pool; });
      top.push(rest);
    }
    var max = top.length ? top[0].fdv : 1;
    var W = 1320, rowH = 26, H = top.length * rowH + 8;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Board value by sector">';
    top.forEach(function (c, i) {
      var y = 6 + i * rowH;
      var w = Math.max(2, Math.round((c.fdv / max) * 640));
      var op = (0.95 - i * 0.055).toFixed(2);
      svg += '<text x="0" y="' + (y + 13) + '" class="svg-lab">' + esc(c.name) + '</text>';
      svg += '<rect x="230" y="' + y + '" width="' + w + '" height="16" rx="3" fill="#00FF9D" opacity="' + op + '"></rect>';
      svg += '<text x="' + (240 + w) + '" y="' + (y + 13) + '" class="svg-val">' + esc(fmtUsd(c.fdv)) + ' \u00B7 ' + c.count + ' rows \u00B7 pool ' + esc(fmtUsd(c.pool)) + '</text>';
    });
    svg += '</svg>';
    return el('section', { class: 'panel sector-panel' },
      el('h3', { class: 'mono', text: 'SECTOR SWEEP \u2014 WHERE THE BOARD\u2019S IMPLIED VALUE SITS' }),
      el('p', { class: 'sub', text: 'Aggregate estimated FDV and candidate count per sector, from the same fitted values as the board. The widest bar is the sector carrying the most pre-token value.' }),
      el('div', { class: 'svg-wrap', html: svg })
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
      opt('ev', 'Airdrop EV / wallet', state.sort),
      opt('efficiency', 'EV / Gas Efficiency', state.sort),
      opt('growth', '7d Growth', state.sort),
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
      el('p', { class: 'sub', text: 'These protocols already trade. The fit is fitted on their market caps and TVLs \u2014 the market\u2019s own values, set apart from the pre-token ranking.' }),
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

  // ---- farm plan export ---------------------------------------------------
  function planText(row) {
    var m = row.model;
    var eff = row.gas.ev_gas_multiple;
    var lines = [
      'TOKEN RADAR \u2014 FARM PLAN',
      row.name + ' \u00B7 rank #' + row.rank + ' of ' + DATA.board_size + ' \u00B7 ' + (row.category || 'Other') + ' \u00B7 ' + (row.chains || []).join(', '),
      'Snapshot ' + DATA.as_of + ' \u00B7 model ' + DATA.model_version + ' (' + DATA.fit.chosen_label + ')',
      '',
      'Est. token FDV: ' + fmtNum(row.implied_value_usd) + ' (fitted multiple ' + m.fitted_multiple.toFixed(4) + 'x, ' + m.fit_source + ' fit, ' + m.comp_count + ' category comps, offset weight ' + m.fit_weight.toFixed(2) + ')',
      'Airdrop pool (' + Math.round(row.airdrop.share_pct * 100) + '% of FDV): ' + fmtNum(row.airdrop.pool_usd) + ' \u00B7 per wallet ' + fmtNum(row.airdrop.per_wallet_usd) + ' across ' + row.airdrop.wallets_assumed.toLocaleString('en-US') + ' assumed wallets',
      'EV-to-gas: ' + (eff === null ? 'n/a' : eff + 'x') + ' (' + row.airdrop.ev_rating + ') \u00B7 gas ' + row.gas.cost_label + ' per tx \u00B7 ' + fmtGas(row.gas.gas_30d_usd) + ' per 30 days \u00B7 ' + fmtGas(row.gas.total_plan_gas_usd) + ' over 12 weeks',
      'Capital: ' + row.capital_range + ' \u00B7 hands-on time: about ' + fmtMinutes(row.total_minutes) + ' over 12 weeks',
      '',
      'Steps:'
    ];
    row.farm_steps.forEach(function (s, i) { lines.push((i + 1) + '. ' + s); });
    lines.push('');
    lines.push('Implied values and airdrop figures are this board\u2019s own claims, never prices or promises.');
    return lines.join('\n');
  }
  function exportPlan(row) {
    var blob = new Blob([planText(row)], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: row.slug + '-farm-plan.txt' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
      el('div', { class: 'step' }, el('span', { class: 'lab', text: 'Fitted FDV / TVL' }), el('b', { text: m.fitted_multiple.toFixed(4) + 'x' }), el('span', { class: 'lab', text: m.fit_source === 'category' ? 'category offset carries \u00B7 ' + m.comp_count + ' comps \u00B7 weight ' + m.fit_weight.toFixed(2) : 'global surface \u00B7 ' + m.comp_count + ' category comps \u00B7 offset weight ' + m.fit_weight.toFixed(2) })),
      el('span', { class: 'op', text: '\u00D7' }),
      el('div', { class: 'step' }, el('span', { class: 'lab', text: 'Category Offset' }), el('b', { text: '\u00D7' + m.category_factor.toFixed(4) })),
      el('span', { class: 'op', text: '\u00D7' }),
      el('div', { class: 'step' }, el('span', { class: 'lab', text: 'Calibration' }), el('b', { text: '\u00D7' + m.calibration_factor.toFixed(4) })),
      el('span', { class: 'op', text: '=' }),
      el('div', { class: 'step result' }, el('span', { class: 'lab', text: 'Est. Token FDV' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
    );
    var factors = el('div', { class: 'peers' }, m.factors.map(function (f) {
      return el('span', { class: 'peer' }, document.createTextNode(f.label + ' '), el('b', { text: '\u00D7' + f.factor.toFixed(4) }));
    }));
    var peers = el('div', { class: 'peers' }, m.peers.map(function (p) {
      return el('span', { class: 'peer' }, document.createTextNode(p.name + ' '), el('b', { text: p.ratio.toFixed(4) + 'x' }), document.createTextNode(' \u00B7 ' + fmtUsd(p.mcap_usd)));
    }));
    if (m.floor_estimate) peers.appendChild(el('span', { class: 'peer', text: 'Floor estimate: no positive TVL on record, priced from the fit at the category median TVL' }));
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
        el('h3', null, el('span', { text: '01 // ' }), document.createTextNode('Multi-feature valuation breakdown')),
        el('span', { class: 'eff-badge', text: 'Est. airdrop pool (' + Math.round(row.airdrop.share_pct * 100) + '%): ' + fmtUsd(row.airdrop.pool_usd) }),
        formula,
        el('p', { class: 'sub', text: 'Strongest contributing factors, against the pool-average listed protocol:' }),
        factors,
        el('p', { class: 'sub', text: 'Nearest listed peers by TVL, the fit\u2019s own evidence (same sector first):' }),
        peers,
        el('p', { class: 'note', text: 'Base ' + fmtNum(m.base_usd) + ' = the fitted value at this TVL, TVL \u00D7 ' + m.fitted_multiple.toFixed(4) + 'x. Per-wallet figure: ' + fmtUsd(row.airdrop.per_wallet_usd) + ' (pool \u00F7 ' + row.airdrop.wallets_assumed.toLocaleString('en-US') + ' assumed active wallets for this TVL tier \u2014 the board\u2019s own assumption, never a promise). EV rating: ' + row.airdrop.ev_rating + '.' })
      ),
      el('section', { class: 'sec' },
        el('h3', null, el('span', { text: '02 // ' }), document.createTextNode('Concrete farming plan & chain gas telemetry')),
        el('span', { class: 'eff-badge', text: 'EV-to-gas: ' + effText }),
        el('div', { class: 'stats3' },
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Avg gas / tx \u00B7 ' + (row.chains[0] || 'main chain') }), el('div', { class: 'val', text: row.gas.cost_label })),
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Est. 30-day gas (' + row.gas.actions_per_week + ' actions / week)' }), el('div', { class: 'val', text: fmtGas(row.gas.gas_30d_usd) })),
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Recommended min capital' }), el('div', { class: 'val cyn', text: row.capital_range }))
        ),
        el('div', { class: 'stats3' },
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Total gas, 12 weeks' }), el('div', { class: 'val', text: fmtGas(row.gas.total_plan_gas_usd) })),
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Total hands-on time' }), el('div', { class: 'val', text: fmtMinutes(row.total_minutes) })),
          el('div', { class: 'cell' }, el('div', { class: 'lab', text: 'Est. airdrop EV / wallet' }), el('div', { class: 'val cyn', text: fmtUsd(row.airdrop.per_wallet_usd) }))
        ),
        steps,
        el('button', { class: 'btn primary export-btn', type: 'button', text: 'EXPORT THIS PLAN (.TXT)', onclick: function () { exportPlan(row); } })
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
    shell.appendChild(sectorPanel());
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
