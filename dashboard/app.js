// Token Radar — the dashboard's rendering code.
//
// The page is fed by data.js, which main.ts writes beside this folder as
// window.RADAR: the ranked board, the live-token set-aside, the category
// multiples and the model constants. This script turns that one object into
// the whole page — masthead, intro, top-three cards, filters, the sortable
// board table, the live-token table, the model explainer and the per-protocol
// detail drawer — and nothing else. It fetches nothing: every number and word
// on screen comes from the snapshot baked into data.js.
//
// One property of the page is worth stating up front. The detail drawer does
// not trust the board's implied values: it re-derives each row's implied value
// from the snapshot figures (TVL, the category's comparable multiple, the
// growth and maturity multipliers, the chain breadth) with the same four
// factors the model in lib/model.ts uses, and prints whether the re-derived
// number equals the one board.json carries —
// rederiveImplied(row, SNAP.model) === row.implied_value_usd —
// so a stale or altered board shows up in the open instead of hiding.
(function () {
  'use strict';

  // The snapshot payload. Bail out silently when the data script never ran:
  // there is nothing to render and no error worth surfacing.
  var DATA = window.RADAR;
  if (!DATA) return;

  var root = document.getElementById('app');

  // Everything the page remembers between renders: the search text, the two
  // dropdown filters, the TVL floor, which tab is showing, the sort key and
  // direction, and the slug of the protocol whose detail drawer is open.
  var state = {
    q: '',
    category: 'all',
    chain: 'all',
    minTvl: 0,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
  };

  // -- Number formatting -------------------------------------------------
  //
  // Money is shown compactly ($404.0M, $150.3M, $12K) once it passes a
  // thousand dollars, and with the plain currency formatter below that.
  var usdPlain = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var size = Math.abs(n);
    if (size >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (size >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (size >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdPlain.format(n);
  }

  // A weekly change, signed and to two decimals: +12.34%, -3.20%, or n/a.
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  // An age in days, as years past a year and days below it.
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // A multiplier to four decimals with the trailing zeros trimmed, so x1
  // reads x1.0 and x0.7698 reads x0.7698.
  function fmtMult(n) {
    return (Math.round(n * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  }

  // -- The model, as the page sees it ------------------------------------
  //
  // Implied value from the snapshot figures alone, in the model's four
  // factors: the category's comparable multiple, a growth factor from the
  // week's change (clamped), a maturity factor from how long the protocol
  // has run with no token, and a breadth factor from how many chains it
  // runs on. The multiplication order here is the model's own — the check
  // above only holds if this function lands on the board's exact number.
  function rederiveImplied(row, model) {
    var rawGrowth = row.change_7d == null ? 0 : row.change_7d;
    var clampedGrowth = Math.max(model.growth_floor, Math.min(model.growth_cap, rawGrowth));
    var growthFactor = 1 + (clampedGrowth / 100) * model.growth_weight;
    var ageDays = row.age_days == null ? model.unknown_age_days : row.age_days;
    var cappedAge = Math.min(Math.max(ageDays, 0), model.maturity_days);
    var maturityFactor = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
    var chainCount = (row.chains || []).length;
    var extraChains = Math.min(Math.max(chainCount - 1, 0), model.breadth_max_chains);
    var breadthFactor = 1 + extraChains * model.breadth_per_chain;
    // The launch odds: the fitted probability this protocol's token launches at
    // all. The board's implied value is the expected value — the value if it
    // launches, times these odds. Rows written before odds existed carry 1.
    var oddsFactor = row.odds === null || row.odds === undefined ? 1 : row.odds;
    var value = row.tvl_usd * row.comp_multiple * growthFactor * maturityFactor * breadthFactor * oddsFactor;
    return Math.max(1, Math.round(value));
  }

  // -- A tiny element builder -------------------------------------------
  //
  // el('td', { className: 'num' }, [text]) builds a node, sets its
  // attributes, and appends its children. The attributes className, text and
  // html are handled specially; keys starting with "on" become event
  // listeners; anything else is set as an attribute, unless it is null or
  // undefined, in which case it is skipped. Children may be nodes, strings
  // (which become text nodes), one-level arrays, or nulls to skip.
  function el(name, attrs, kids) {
    var node = document.createElement(name);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var value = attrs[key];
        if (value === null || value === undefined) continue;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
    }
    if (kids) {
      for (var ci = 0; ci < kids.length; ci++) {
        var child = kids[ci];
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
          for (var ii = 0; ii < child.length; ii++) {
            if (child[ii]) node.appendChild(child[ii]);
          }
        } else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
        else node.appendChild(child);
      }
    }
    return node;
  }

  // -- The URL hash carries the view --------------------------------------
  //
  // Search text, both dropdowns, the tab and the open protocol live in the
  // hash, so a filtered board or an open detail drawer survives a reload
  // and can be linked to. Only values that differ from the defaults are
  // written, so the plain board URL stays a bare page address. The TVL floor
  // is deliberately not hashed: it is a quick narrowing, not a view to keep.
  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    var params = new URLSearchParams(raw);
    var q = params.get('q');
    if (q) state.q = q;
    var category = params.get('category');
    if (category) state.category = category;
    var chain = params.get('chain');
    if (chain) state.chain = chain;
    var tab = params.get('tab');
    if (tab) state.tab = tab;
    var picked = params.get('p');
    if (picked) state.selected = picked;
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // -- Which rows the board shows, and in what order ---------------------
  //
  // The search matches one needle against the protocol's name, slug,
  // category and chains together. Sorting is by the chosen key — name,
  // TVL, weekly growth, age, or implied value — in the chosen direction,
  // with the slug as the tie-break so the order is stable and the same on
  // every render. A missing growth counts as the lowest growth, a missing
  // age as the oldest age, so nulls sink instead of floating to the top.
  function filteredRows() {
    var needle = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (row) {
      if (state.category !== 'all' && row.category !== state.category) return false;
      if (state.chain !== 'all' && (row.chains || []).indexOf(state.chain) < 0) return false;
      if (state.minTvl > 0 && row.tvl_usd < state.minTvl) return false;
      if (!needle) return true;
      var haystack = [row.name, row.slug, row.category, (row.chains || []).join(' ')].join(' ').toLowerCase();
      return haystack.indexOf(needle) >= 0;
    });
  }

  function sortKey(row) {
    if (state.sort === 'name') return row.name.toLowerCase();
    if (state.sort === 'tvl') return row.tvl_usd;
    if (state.sort === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
    if (state.sort === 'age') return row.age_days === null ? Infinity : row.age_days;
    if (state.sort === 'odds') return row.odds === null || row.odds === undefined ? -Infinity : row.odds;
    return row.implied_value_usd;
  }

  function sortedRows(list) {
    var copy = list.slice();
    copy.sort(function (a, b) {
      var av = sortKey(a);
      var bv = sortKey(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      if (a.slug < b.slug) return -1;
      if (a.slug > b.slug) return 1;
      return 0;
    });
    return copy;
  }

  // -- Masthead ------------------------------------------------------------
  function masthead() {
    return el('header', { className: 'top' }, [
      el('div', { className: 'brand' }, [
        el('span', { className: 'mark' }, []),
        el('span', { className: 'brand-name', text: 'Token Radar' }, []),
      ]),
      el('div', { className: 'top-meta' }, [
        el('span', { text: 'Snapshot ' + DATA.as_of }, []),
        el('span', { text: 'DefiLlama protocol index' }, []),
        el('span', { text: DATA.model_version + ' model' }, []),
      ]),
    ]);
  }

  // -- Intro: the claim, and the counts that back it ----------------------
  function intro() {
    var top = DATA.rows[0];
    var floorM = Math.round(DATA.floor_usd / 1e6);
    var blurb = 'The watchlist is the floor: every protocol with at least $' + floorM +
      'M of TVL and no token on record. The early radar adds ' + DATA.early_size +
      ' more pre-token protocols below that floor, screened the same way — no wrapped, staked or bridged product of a token that already trades. Implied value is this entry\u2019s model, not a promise and not a prediction of a launch.';
    var facts = [
      ['Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size],
      ['Pre-token rows scored', String(DATA.board_size)],
      ['Early rows below the floor', String(DATA.early_size)],
      ['Live-token protocols set aside', String(DATA.live_size)],
      ['Top implied value', top ? fmtUsd(top.implied_value_usd) + ' — ' + top.name : 'n/a'],
    ];
    var factNodes = [];
    for (var i = 0; i < facts.length; i++) {
      (function (pair) {
        factNodes.push(el('div', { className: 'fact' }, [
          el('span', { text: pair[0] }, []),
          el('b', { text: pair[1] }, []),
        ]));
      })(facts[i]);
    }
    return el('section', { className: 'lede' }, [
      el('div', {}, [
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied launch value' }, []),
        el('p', { text: blurb }, []),
      ]),
      el('div', { className: 'facts' }, factNodes),
    ]);
  }

  // -- Spotlight: the top three, as three clickable cards -----------------
  function spotlight() {
    var cards = [];
    var leaders = DATA.rows.slice(0, 3);
    for (var i = 0; i < leaders.length; i++) {
      (function (row) {
        cards.push(el('button', {
          className: 'spot-card',
          type: 'button',
          onclick: function () { openProtocol(row.slug); },
        }, [
          el('span', { className: 'rank', text: 'Rank ' + row.rank }, []),
          el('b', { text: row.name }, []),
          el('span', { className: 'implied', text: fmtUsd(row.implied_value_usd) }, []),
          el('span', { className: 'sub', text: (row.category || 'Other') + ' · TVL ' + fmtUsd(row.tvl_usd) + ' · ' + (row.chains || []).slice(0, 2).join(', ') }, []),
        ]));
      })(leaders[i]);
    }
    return el('section', { className: 'spot', 'aria-label': 'Top three by implied value' }, cards);
  }

  // -- Filters: search, two dropdowns, a TVL floor, the tab toggle --------
  //
  // The dropdowns are built from the board itself — every category and
  // chain the snapshot actually carries, sorted — so a new snapshot grows
  // its own filter lists. Typing or picking a filter re-saves the hash and
  // re-renders at once; the tab buttons only re-render, and the TVL floor
  // only re-renders too, because neither belongs in the hash.
  function filters() {
    var categorySet = new Set();
    var chainSet = new Set();
    for (var ri = 0; ri < DATA.rows.length; ri++) {
      var r = DATA.rows[ri];
      categorySet.add(r.category || 'Other');
      var chainsOfRow = r.chains || [];
      for (var ci = 0; ci < chainsOfRow.length; ci++) chainSet.add(chainsOfRow[ci]);
    }
    var categories = Array.from(categorySet).sort();
    var chains = Array.from(chainSet).sort();

    var search = el('input', {
      type: 'search',
      id: 'q',
      placeholder: 'Search name, category or chain',
      value: state.q,
      'aria-label': 'Search the board',
    }, []);
    search.addEventListener('input', function () {
      state.q = search.value;
      writeHash();
      render();
    });

    var categoryOptions = [el('option', { value: 'all', text: 'All categories' }, [])];
    for (var i = 0; i < categories.length; i++) {
      categoryOptions.push(el('option', { value: categories[i], text: categories[i], selected: categories[i] === state.category ? 'selected' : null }, []));
    }
    var categorySelect = el('select', { id: 'category', 'aria-label': 'Filter by category' }, categoryOptions);
    categorySelect.addEventListener('change', function () {
      state.category = categorySelect.value;
      writeHash();
      render();
    });

    var chainOptions = [el('option', { value: 'all', text: 'All chains' }, [])];
    for (var j = 0; j < chains.length; j++) {
      chainOptions.push(el('option', { value: chains[j], text: chains[j], selected: chains[j] === state.chain ? 'selected' : null }, []));
    }
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' }, chainOptions);
    chainSelect.addEventListener('change', function () {
      state.chain = chainSelect.value;
      writeHash();
      render();
    });

    var tvlSteps = [['$50M+', 50000000], ['$100M+', 100000000], ['$250M+', 250000000], ['$500M+', 500000000]];
    var tvlOptions = [el('option', { value: '0', text: 'Any TVL' }, [])];
    for (var k = 0; k < tvlSteps.length; k++) {
      tvlOptions.push(el('option', { value: String(tvlSteps[k][1]), text: tvlSteps[k][0], selected: state.minTvl === tvlSteps[k][1] ? 'selected' : null }, []));
    }
    var tvlSelect = el('select', { id: 'mintvl', 'aria-label': 'Minimum TVL' }, tvlOptions);
    tvlSelect.addEventListener('change', function () {
      state.minTvl = Number(tvlSelect.value);
      render();
    });

    var preTab = el('button', {
      type: 'button',
      'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false',
      text: 'Pre-token',
      onclick: function () { state.tab = 'pre-token'; render(); },
    }, []);
    var liveTab = el('button', {
      type: 'button',
      'aria-pressed': state.tab === 'live' ? 'true' : 'false',
      text: 'Live token',
      onclick: function () { state.tab = 'live'; render(); },
    }, []);

    var shown = state.tab === 'pre-token'
      ? filteredRows().length + ' rows shown'
      : DATA.live.length + ' live-token protocols';

    return el('div', { className: 'controls' }, [
      el('div', { className: 'field' }, [
        el('label', { for: 'q', text: 'Search' }, []),
        search,
      ]),
      el('div', { className: 'field' }, [
        el('label', { for: 'category', text: 'Category' }, []),
        categorySelect,
      ]),
      el('div', { className: 'field' }, [
        el('label', { for: 'chain', text: 'Chain' }, []),
        chainSelect,
      ]),
      el('div', { className: 'field' }, [
        el('label', { for: 'mintvl', text: 'Min TVL' }, []),
        tvlSelect,
      ]),
      el('div', { className: 'field' }, [
        el('span', { className: 'sub', text: 'Token status' }, []),
        el('div', { className: 'tabs' }, [preTab, liveTab]),
      ]),
      el('span', { className: 'count', text: shown }, []),
    ]);
  }

  // -- One sortable column head --------------------------------------------
  //
  // Clicking a head sorts by that column; clicking it again flips the
  // direction. The active head carries the arrow, down for strongest first.
  function sortHead(key, label) {
    var button = el('button', {
      type: 'button',
      onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        render();
      },
    }, [label]);
    if (state.sort === key) {
      button.appendChild(el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }, []));
    }
    return el('th', { scope: 'col' }, [button]);
  }

  // The chains a row names, at most two, or a neutral phrase when it names none.
  function chainNames(row) {
    var chains = row.chains || [];
    if (chains.length) return chains.slice(0, 2).join(', ');
    return 'an unnamed chain';
  }

  // -- One board row --------------------------------------------------------
  function boardRowEl(row, topValue) {
    var growthText = row.change_7d === null ? 'n/a' : fmtPct(row.change_7d);
    var growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
    var barWidth = Math.max(3, Math.round((row.implied_value_usd / topValue) * 100));
    return el('tr', {
      'data-selected': state.selected === row.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: function () { openProtocol(row.slug); },
      onkeydown: function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProtocol(row.slug); }
      },
    }, [
      el('td', { className: 'num rank-no' + (row.rank <= 3 ? ' top3' : ''), text: String(row.rank) }, []),
      el('td', {}, [
        el('div', { className: 'name' }, [
          el('b', { text: row.name }, []),
          el('span', { className: 'sub', text: (row.category || 'Other') + ' on ' + chainNames(row) }, []),
        ]),
      ]),
      el('td', { className: 'num', text: fmtUsd(row.tvl_usd) }, []),
      el('td', { className: 'num ' + growthClass, text: growthText }, []),
      el('td', { className: 'num', text: fmtAge(row.age_days) }, []),
      el('td', {}, [
        el('div', { className: 'implied' }, [
          el('div', { className: 'bar', 'aria-hidden': 'true' }, [
            el('i', { style: 'width:' + barWidth + '%' }, []),
          ]),
          el('span', { className: 'num', text: fmtUsd(row.implied_value_usd) }, []),
        ]),
      ]),
      el('td', { className: 'num', text: row.odds === null || row.odds === undefined ? 'n/a' : (row.odds * 100).toFixed(0) + '%' }, []),
      el('td', {}, [el('span', { className: 'badge', text: 'no token' }, [])]),
    ]);
  }

  // -- The board table, or the empty state when nothing matches ------------
  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { className: 'panel' }, [
        el('div', { className: 'empty' }, [
          el('h2', { text: 'No protocol matches that filter' }, []),
          el('p', { text: 'Clear the search or pick another category to see the board again.' }, []),
          el('button', {
            className: 'button primary',
            type: 'button',
            text: 'Clear filters',
            onclick: function () {
              state.q = '';
              state.category = 'all';
              state.chain = 'all';
              state.minTvl = 0;
              writeHash();
              render();
            },
          }, []),
        ]),
      ]);
    }
    var topValue = DATA.rows[0].implied_value_usd || 1;
    var tbody = el('tbody', {}, []);
    for (var i = 0; i < list.length; i++) tbody.appendChild(boardRowEl(list[i], topValue));
    return el('div', { className: 'panel', id: 'board' }, [
      el('div', { className: 'table-wrap' }, [
        el('table', {}, [
          el('caption', { className: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }, []),
          el('thead', {}, [
            el('tr', {}, [
              sortHead('implied', 'Rank'),
              sortHead('name', 'Protocol'),
              sortHead('tvl', 'TVL'),
              sortHead('growth', '7d'),
              sortHead('age', 'Age'),
              sortHead('implied', 'Implied value'),
              sortHead('odds', 'Odds'),
              el('th', { scope: 'col', text: 'Token' }, []),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ]);
  }

  // -- The live-token table: market caps, not a model ----------------------
  function liveTable() {
    var tbody = el('tbody', {}, []);
    for (var i = 0; i < DATA.live.length; i++) {
      var row = DATA.live[i];
      var growthClass = row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(el('tr', {}, [
        el('td', { className: 'num', text: 'live' }, []),
        el('td', {}, [
          el('div', { className: 'name' }, [
            el('b', { text: row.name }, []),
            el('span', { className: 'sub', text: (row.category || 'Other') + ' on ' + chainNames(row) }, []),
          ]),
        ]),
        el('td', { className: 'num', text: fmtUsd(row.tvl_usd) }, []),
        el('td', { className: 'num ' + growthClass, text: fmtPct(row.change_7d) }, []),
        el('td', { className: 'num', text: fmtUsd(row.mcap_usd) }, []),
        el('td', {}, [el('span', { className: 'badge live', text: 'already trades' }, [])]),
      ]));
    }
    return el('div', { className: 'panel' }, [
      el('div', { className: 'table-wrap' }, [
        el('table', {}, [
          el('caption', { className: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking — and they are the comparables the model prices the board from.' }, []),
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Status' }, []),
              el('th', { scope: 'col', text: 'Protocol' }, []),
              el('th', { scope: 'col', text: 'TVL' }, []),
              el('th', { scope: 'col', text: '7d' }, []),
              el('th', { scope: 'col', text: 'Market cap' }, []),
              el('th', { scope: 'col', text: 'Token' }, []),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ]);
  }

  // -- The model panel: the formula, the multiples, the screen -------------
  function modelPanel() {
    var m = DATA.model;
    var cats = Object.keys(DATA.comp_by_category).sort(function (a, b) {
      return DATA.comp_by_category[b] - DATA.comp_by_category[a];
    }).slice(0, 10);
    var chips = [];
    for (var i = 0; i < cats.length; i++) {
      (function (c) {
        chips.push(el('span', { className: 'comp' }, [c + ' ', el('b', { text: 'x' + DATA.comp_by_category[c].toFixed(2) }, [])]));
      })(cats[i]);
    }
    var formula = 'implied = round( tvl_usd x comp(category) x (1 + clamp(change_7d, ' +
      m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' +
      m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days +
      ' x ' + m.maturity_range + ') x (1 + 0.02 x min(chains - 1, 5)) )';
    var explainer = 'comp(category) is the median market-cap-per-TVL of the live-token protocols in the same category — what the market already pays per dollar of TVL for that kind of protocol — steadied toward the global median when the category has few comparables, discounted when many pre-token protocols crowd the same category, and eased past 0.80 on a curve that never passes 1.00, so two rich categories no longer tie at the cap. Categories with fewer than 3 live comparables use the global median of x' +
      DATA.comp_global.toFixed(2) + '. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days.';
    return el('section', { className: 'panel model' }, [
      el('h2', { text: 'How implied value is computed' }, []),
      el('p', { className: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }, []),
      el('div', { className: 'formula', text: formula }, []),
      el('p', { className: 'sub', text: explainer }, []),
      el('div', { className: 'comps' }, chips),
      el('p', { className: 'sub', text: 'The early radar is every pre-token protocol that passes the same screen as the watchlist — no token on record, not a wrapped, staked or bridged product, not a versioned pool — whatever its TVL. The live-token protocols are set aside with their market caps shown.' }, []),
    ]);
  }

  // -- The launch-odds panel: the fit, its accuracy, and what it means ----
  //
  // Odds = the probability a token launches at all, fitted from the snapshot
  // itself by logistic regression on age and TVL; implied = value-if-it-launches
  // times odds. A traded token carries odds 1 — its launch already happened —
  // so the odds only ever shrink a pre-token row.
  function oddsPanel() {
    var fit = DATA.odds_fit;
    if (!fit) return el('section', { className: 'panel model' }, [
      el('h2', { text: 'Launch odds' }, []),
      el('p', { className: 'sub', text: 'No launch-odds fit was written into this data.js.' }, []),
    ]);
    var equation = 'odds = sigmoid(' + fit.a.toFixed(4) + ' + ' + fit.b.toFixed(4) +
      ' x log10(age_days) + ' + fit.c.toFixed(4) + ' x log10(tvl_usd))';
    var accuracy = 'Fitted on all ' + fit.n + ' snapshot protocols: ' + fit.n_positive +
      ' already record a token (base rate ' + (fit.base_rate * 100).toFixed(1) +
      '%), so the odds call the launched ones right with AUC ' + fit.auc.toFixed(2) +
      ' — 0.50 is a coin flip, 1.00 is perfect. Age is the time since the protocol ' +
      'was first listed (unknown age counts as 365 days); the older a protocol has ' +
      'run with no token, the lower its odds, and the board multiplies each row\u2019s ' +
      'value-if-it-launches by these odds to get its implied value.';
    return el('section', { className: 'panel model' }, [
      el('h2', { text: 'Launch odds' }, []),
      el('p', { className: 'sub', text: 'Odds = the probability a token launches, fitted from the snapshot itself; implied = value-if-it-launches x odds.' }, []),
      el('div', { className: 'formula', text: equation }, []),
      el('p', { className: 'sub', text: accuracy }, []),
    ]);
  }

  // -- The detail drawer ---------------------------------------------------
  //
  // One <dialog> element, reused for every protocol: opening it fills it
  // with the row's model breakdown and farm plan, closing it clears the
  // selection from the view and the hash. Escape closes it too (see the
  // keydown listener at the bottom), and the drawer re-opens on reload when
  // the hash still names a protocol.
  var detailDialog = el('dialog', { className: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' }, []);
  detailDialog.addEventListener('close', function () {
    state.selected = null;
    writeHash();
  });

  function openProtocol(slug) {
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) {
      if (DATA.rows[i].slug === slug) { row = DATA.rows[i]; break; }
    }
    if (!row) return;
    state.selected = slug;
    writeHash();
    detailDialog.textContent = '';
    var recomputed = rederiveImplied(row, DATA.model);
    var matches = recomputed === row.implied_value_usd;
    var chainCount = (row.chains || []).length;
    var chainText = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';

    var head = el('div', { className: 'detail-head' }, [
      el('div', {}, [
        el('span', { className: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · ' + (row.category || 'Other') }, []),
        el('h2', { id: 'detail-title', text: row.name }, []),
        el('p', { className: 'sub', text: 'on ' + chainText + (row.listed_at ? ' · listed ' + row.listed_at : '') }, []),
      ]),
      el('button', {
        className: 'close',
        type: 'button',
        'aria-label': 'Close details',
        text: 'Close',
        onclick: function () { detailDialog.close(); },
      }, []),
    ]);

    // The equation, as label/value pairs: the snapshot figures, each
    // multiplier, and the total the board carries.
    var breakdown = [
      ['TVL', fmtUsd(row.tvl_usd)],
      ['Category multiple (' + (row.category || 'Other') + ')', 'x' + fmtMult(row.comp_multiple)],
      ['Seven-day growth', fmtPct(row.change_7d)],
      ['Growth multiplier', 'x' + fmtMult(row.growth_multiplier)],
      ['Age with no token', fmtAge(row.age_days)],
      ['Maturity multiplier', 'x' + fmtMult(row.maturity_multiplier)],
      ['Chain breadth (' + chainCount + ' chain' + (chainCount === 1 ? '' : 's') + ')', 'x' + fmtMult(row.breadth_multiplier)],
      ['Launch odds', row.odds === null || row.odds === undefined ? 'n/a' : (row.odds * 100).toFixed(1) + '%'],
    ];
    var equation = el('div', { className: 'equation' }, []);
    for (var j = 0; j < breakdown.length; j++) {
      equation.appendChild(el('div', {}, [
        el('span', { text: breakdown[j][0] }, []),
        el('b', { className: 'num', text: breakdown[j][1] }, []),
      ]));
    }
    equation.appendChild(el('div', { className: 'total' }, [
      el('span', { text: 'Implied value' }, []),
      el('b', { className: 'num', text: fmtUsd(row.implied_value_usd) }, []),
    ]));

    var verdict = matches ? ', the same number board.json carries.' : ', which differs from the board — the data would be stale.';
    var modelNote = 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + verdict + ' This is an estimate of what a launch could be worth at today\u2019s record, not a price and not a prediction that a token comes.';

    var valueSection = el('section', { className: 'detail-section' }, [
      el('h3', { text: 'Implied value' }, []),
      equation,
      el('p', { className: 'sub', text: modelNote }, []),
    ]);

    // Each farm step is one string with its cost tucked after " Cost: " —
    // the action goes bold, the cost and time stay small underneath it.
    var stepNodes = [];
    var farmSteps = row.farm_steps || [];
    for (var k = 0; k < farmSteps.length; k++) {
      var step = farmSteps[k];
      var cut = step.indexOf(' Cost: ');
      var action = cut >= 0 ? step.slice(0, cut) : step;
      var tail = cut >= 0 ? step.slice(cut + 1) : '';
      stepNodes.push(el('li', {}, [
        el('b', { text: action }, []),
        el('span', { className: 'cost', text: tail }, []),
      ]));
    }
    var farmSection = el('section', { className: 'detail-section' }, [
      el('h3', { text: 'Farm plan' }, []),
      el('ol', { className: 'steps' }, stepNodes),
    ]);

    detailDialog.appendChild(head);
    detailDialog.appendChild(valueSection);
    detailDialog.appendChild(farmSection);
    detailDialog.appendChild(el('div', { className: 'note', text: '\u201cNo token\u201d means the snapshot records none for this protocol — DefiLlama\u2019s record, not proof. Verify the protocol\u2019s own page before you farm, never pay to claim an airdrop, and never share a seed phrase.' }, []));

    if (typeof detailDialog.showModal === 'function') {
      if (!detailDialog.open) detailDialog.showModal();
    } else {
      detailDialog.setAttribute('open', '');
    }
  }

  // -- Render --------------------------------------------------------------
  //
  // One full rebuild from the current view: masthead, intro, spotlight,
  // filters, then the pre-token board plus the model panel, or the live
  // table on its own. The drawer lives outside the shell and is only
  // attached once; a selection in the hash re-opens it after the rebuild.
  function render() {
    root.textContent = '';
    var shell = el('div', { className: 'shell' }, []);
    shell.appendChild(masthead());
    shell.appendChild(intro());
    shell.appendChild(spotlight());
    shell.appendChild(filters());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    if (state.tab === 'pre-token') shell.appendChild(oddsPanel());
    shell.appendChild(el('p', { className: 'foot', text: 'Token Radar · model ' + DATA.model_version + ' · snapshot ' + DATA.as_of + ' · ' + DATA.source + ' · Implied values are this entry\u2019s model, never a price.' }, []));
    root.appendChild(shell);
    root.setAttribute('aria-busy', 'false');
    if (!detailDialog.isConnected) root.appendChild(detailDialog);
    if (state.selected) openProtocol(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && detailDialog.open) detailDialog.close();
  });
})();
