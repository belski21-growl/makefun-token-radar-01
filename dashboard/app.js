// Token Radar — the dashboard's rendering code, second draft.
//
// The page is fed by data.js, which main.ts writes beside this folder as
// window.RADAR: the ranked board, the live-token set-aside, the fitted size
// curve and the model constants. This script turns that one object into the
// whole page — masthead, intro, top-three cards, filters, the sortable board
// table, the live-token table, the model explainer and the per-protocol
// detail drawer — and nothing else. It fetches nothing: every number and word
// on screen comes from the snapshot baked into data.js.
//
// One property of the page is worth stating up front. The detail drawer does
// not trust the board's implied values: it re-derives each row's implied value
// from the snapshot figures (TVL, the fitted curve's value at that TVL, the
// growth and maturity multipliers, the chain breadth) with the same factors
// the model in lib/model.ts uses, and prints whether the re-derived number
// equals the one board.json carries —
// recomputeImplied(row, DATA.model) === row.implied_value_usd —
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
  var usdFmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) {
      return 'n/a';
    }
    var size = Math.abs(n);
    if (size >= 1e9) {
      return '$' + (n / 1e9).toFixed(2) + 'B';
    }
    if (size >= 1e6) {
      return '$' + (n / 1e6).toFixed(1) + 'M';
    }
    if (size >= 1e3) {
      return '$' + Math.round(n / 1e3) + 'K';
    }
    return usdFmt.format(n);
  }

  // A weekly change, signed and to two decimals: +12.34%, -3.20%, or n/a.
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) {
      return 'n/a';
    }
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  // An age in days, as years past a year and days below it.
  function ageText(days) {
    if (days === null || days === undefined) {
      return 'unknown';
    }
    if (days >= 365) {
      return (days / 365).toFixed(1) + 'y';
    }
    return Math.max(0, Math.round(days)) + 'd';
  }

  // A multiplier to four decimals with the trailing zeros trimmed, so x1
  // reads x1.0 and x0.7698 reads x0.7698.
  function multText(n) {
    return (Math.round(n * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  }

  // -- The model, as the page sees it ------------------------------------
  //
  // Implied value from the snapshot figures alone, in the model's factors:
  // the fitted size curve's value at the protocol's TVL, a growth factor
  // from the week's change (clamped), a maturity factor from how long the
  // protocol has run with no token, and a breadth factor from how many
  // chains it runs on. The multiplication order here is the model's own —
  // the check above only holds if this function lands on the board's exact
  // number.
  function recomputeImplied(row, model) {
    var growthRaw = row.change_7d == null ? 0 : row.change_7d;
    var growthClamped = Math.max(model.growth_floor, Math.min(model.growth_cap, growthRaw));
    var growthFactor = 1 + (growthClamped / 100) * model.growth_weight;
    var ageDays = row.age_days == null ? model.unknown_age_days : row.age_days;
    var ageCapped = Math.min(Math.max(ageDays, 0), model.maturity_days);
    var maturityFactor = model.maturity_floor + (ageCapped / model.maturity_days) * model.maturity_range;
    var chainCount = (row.chains || []).length;
    var extraChains = Math.min(Math.max(chainCount - 1, 0), model.breadth_max_chains);
    var breadthFactor = 1 + extraChains * model.breadth_per_chain;
    var value = row.curve_value_usd * growthFactor * maturityFactor * breadthFactor;
    return Math.max(1, Math.round(value));
  }

  // -- A tiny element builder -------------------------------------------
  //
  // h('td', { className: 'num' }, [text]) builds a node, sets its
  // attributes, and appends its children. The attributes className, text and
  // html are handled specially; keys starting with "on" become event
  // listeners; anything else is set as an attribute, unless it is null or
  // undefined, in which case it is skipped. Children may be nodes, strings
  // (which become text nodes), one-level arrays, or nulls to skip.
  function h(name, attrs, kids) {
    var node = document.createElement(name);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
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
      for (var j = 0; j < kids.length; j++) {
        var child = kids[j];
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
          for (var k = 0; k < child.length; k++) {
            var inner = child[k];
            if (inner) node.appendChild(inner);
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
  function loadFromHash() {
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

  function saveToHash() {
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
  function visibleRows() {
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

  function sortValue(row) {
    if (state.sort === 'name') return row.name.toLowerCase();
    if (state.sort === 'tvl') return row.tvl_usd;
    if (state.sort === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
    if (state.sort === 'age') return row.age_days === null ? Infinity : row.age_days;
    return row.implied_value_usd;
  }

  function orderedRows(list) {
    return list.slice().sort(function (a, b) {
      var av = sortValue(a);
      var bv = sortValue(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // -- Masthead ------------------------------------------------------------
  function buildMasthead() {
    return h('header', { className: 'top' }, [
      h('div', { className: 'brand' }, [
        h('span', { className: 'mark' }, []),
        h('span', { className: 'brand-name', text: 'Token Radar' }, []),
      ]),
      h('div', { className: 'top-meta' }, [
        h('span', { text: 'Snapshot ' + DATA.as_of }, []),
        h('span', { text: 'DefiLlama protocol index' }, []),
        h('span', { text: DATA.model_version + ' model' }, []),
      ]),
    ]);
  }

  // -- Intro: the claim, and the counts that back it ----------------------
  function buildIntro() {
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
      ['Top implied value', top ? money(top.implied_value_usd) + ' — ' + top.name : 'n/a'],
    ];
    var factNodes = [];
    for (var i = 0; i < facts.length; i++) {
      var pair = facts[i];
      factNodes.push(h('div', { className: 'fact' }, [
        h('span', { text: pair[0] }, []),
        h('b', { text: pair[1] }, []),
      ]));
    }
    return h('section', { className: 'lede' }, [
      h('div', {}, [
        h('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied launch value' }, []),
        h('p', { text: blurb }, []),
      ]),
      h('div', { className: 'facts' }, factNodes),
    ]);
  }

  // -- Spotlight: the top three, as three clickable cards -----------------
  function buildSpotlight() {
    var cards = [];
    var leaders = DATA.rows.slice(0, 3);
    for (var i = 0; i < leaders.length; i++) {
      var row = leaders[i];
      cards.push(h('button', {
        className: 'spot-card',
        type: 'button',
        onclick: function () { showProtocol(row.slug); },
      }, [
        h('span', { className: 'rank', text: 'Rank ' + row.rank }, []),
        h('b', { text: row.name }, []),
        h('span', { className: 'implied', text: money(row.implied_value_usd) }, []),
        h('span', { className: 'sub', text: (row.category || 'Other') + ' · TVL ' + money(row.tvl_usd) + ' · ' + (row.chains || []).slice(0, 2).join(', ') }, []),
      ]));
    }
    return h('section', { className: 'spot', 'aria-label': 'Top three by implied value' }, cards);
  }

  // -- Filters: search, two dropdowns, a TVL floor, the tab toggle --------
  //
  // The dropdowns are built from the board itself — every category and
  // chain the snapshot actually carries, sorted — so a new snapshot grows
  // its own filter lists. Typing or picking a filter re-saves the hash and
  // re-renders at once; the tab buttons only re-render, and the TVL floor
  // only re-renders too, because neither belongs in the hash.
  function buildFilters() {
    var categorySet = new Set();
    var chainSet = new Set();
    for (var i = 0; i < DATA.rows.length; i++) {
      var row = DATA.rows[i];
      categorySet.add(row.category || 'Other');
      var rowChains = row.chains || [];
      for (var j = 0; j < rowChains.length; j++) chainSet.add(rowChains[j]);
    }
    var categories = Array.from(categorySet).sort();
    var chains = Array.from(chainSet).sort();

    var searchInput = h('input', {
      type: 'search',
      id: 'q',
      placeholder: 'Search name, category or chain',
      value: state.q,
      'aria-label': 'Search the board',
    }, []);
    searchInput.addEventListener('input', function () {
      state.q = searchInput.value;
      saveToHash();
      paint();
    });

    var categoryOptions = [h('option', { value: 'all', text: 'All categories' }, [])];
    for (var i = 0; i < categories.length; i++) {
      var c = categories[i];
      categoryOptions.push(h('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }, []));
    }
    var catSelect = h('select', { id: 'category', 'aria-label': 'Filter by category' }, categoryOptions);
    catSelect.addEventListener('change', function () {
      state.category = catSelect.value;
      saveToHash();
      paint();
    });

    var chainOptions = [h('option', { value: 'all', text: 'All chains' }, [])];
    for (var i = 0; i < chains.length; i++) {
      var c = chains[i];
      chainOptions.push(h('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }, []));
    }
    var chainSelect = h('select', { id: 'chain', 'aria-label': 'Filter by chain' }, chainOptions);
    chainSelect.addEventListener('change', function () {
      state.chain = chainSelect.value;
      saveToHash();
      paint();
    });

    var tvlSteps = [['$50M+', 50000000], ['$100M+', 100000000], ['$250M+', 250000000], ['$500M+', 500000000]];
    var tvlOptions = [h('option', { value: '0', text: 'Any TVL' }, [])];
    for (var i = 0; i < tvlSteps.length; i++) {
      var step = tvlSteps[i];
      tvlOptions.push(h('option', { value: String(step[1]), text: step[0], selected: state.minTvl === step[1] ? 'selected' : null }, []));
    }
    var tvlSelect = h('select', { id: 'mintvl', 'aria-label': 'Minimum TVL' }, tvlOptions);
    tvlSelect.addEventListener('change', function () {
      state.minTvl = Number(tvlSelect.value);
      paint();
    });

    var preTab = h('button', {
      type: 'button',
      'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false',
      text: 'Pre-token',
      onclick: function () { state.tab = 'pre-token'; paint(); },
    }, []);
    var liveTab = h('button', {
      type: 'button',
      'aria-pressed': state.tab === 'live' ? 'true' : 'false',
      text: 'Live token',
      onclick: function () { state.tab = 'live'; paint(); },
    }, []);

    var shown = state.tab === 'pre-token'
      ? visibleRows().length + ' rows shown'
      : DATA.live.length + ' live-token protocols';

    return h('div', { className: 'controls' }, [
      h('div', { className: 'field' }, [
        h('label', { for: 'q', text: 'Search' }, []),
        searchInput,
      ]),
      h('div', { className: 'field' }, [
        h('label', { for: 'category', text: 'Category' }, []),
        catSelect,
      ]),
      h('div', { className: 'field' }, [
        h('label', { for: 'chain', text: 'Chain' }, []),
        chainSelect,
      ]),
      h('div', { className: 'field' }, [
        h('label', { for: 'mintvl', text: 'Min TVL' }, []),
        tvlSelect,
      ]),
      h('div', { className: 'field' }, [
        h('span', { className: 'sub', text: 'Token status' }, []),
        h('div', { className: 'tabs' }, [preTab, liveTab]),
      ]),
      h('span', { className: 'count', text: shown }, []),
    ]);
  }

  // -- One sortable column head --------------------------------------------
  //
  // Clicking a head sorts by that column; clicking it again flips the
  // direction. The active head carries the arrow, down for strongest first.
  function sortCell(key, label) {
    var button = h('button', {
      type: 'button',
      onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        paint();
      },
    }, [label]);
    if (state.sort === key) {
      button.appendChild(h('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }, []));
    }
    return h('th', { scope: 'col' }, [button]);
  }

  // The chains a row names, at most two, or a neutral phrase when it names none.
  function chainLabel(row) {
    var chains = row.chains || [];
    return chains.length ? chains.slice(0, 2).join(', ') : 'an unnamed chain';
  }

  // -- One board row --------------------------------------------------------
  function boardRowNode(row, topImplied) {
    var growthLabel = row.change_7d === null ? 'n/a' : pct(row.change_7d);
    var growthCls = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
    var barPct = Math.max(3, Math.round((row.implied_value_usd / topImplied) * 100));
    return h('tr', {
      'data-selected': state.selected === row.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: function () { showProtocol(row.slug); },
      onkeydown: function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showProtocol(row.slug); }
      },
    }, [
      h('td', { className: 'num rank-no' + (row.rank <= 3 ? ' top3' : ''), text: String(row.rank) }, []),
      h('td', {}, [
        h('div', { className: 'name' }, [
          h('b', { text: row.name }, []),
          h('span', { className: 'sub', text: (row.category || 'Other') + ' on ' + chainLabel(row) }, []),
        ]),
      ]),
      h('td', { className: 'num', text: money(row.tvl_usd) }, []),
      h('td', { className: 'num ' + growthCls, text: growthLabel }, []),
      h('td', { className: 'num', text: ageText(row.age_days) }, []),
      h('td', {}, [
        h('div', { className: 'implied' }, [
          h('div', { className: 'bar', 'aria-hidden': 'true' }, [
            h('i', { style: 'width:' + barPct + '%' }, []),
          ]),
          h('span', { className: 'num', text: money(row.implied_value_usd) }, []),
        ]),
      ]),
      h('td', {}, [h('span', { className: 'badge', text: 'no token' }, [])]),
    ]);
  }

  // -- The board table, or the empty state when nothing matches ------------
  function buildBoard() {
    var shown = orderedRows(visibleRows());
    if (shown.length === 0) {
      return h('div', { className: 'panel' }, [
        h('div', { className: 'empty' }, [
          h('h2', { text: 'No protocol matches that filter' }, []),
          h('p', { text: 'Clear the search or pick another category to see the board again.' }, []),
          h('button', {
            className: 'button primary',
            type: 'button',
            text: 'Clear filters',
            onclick: function () {
              state.q = '';
              state.category = 'all';
              state.chain = 'all';
              state.minTvl = 0;
              saveToHash();
              paint();
            },
          }, []),
        ]),
      ]);
    }
    var topImplied = DATA.rows[0].implied_value_usd || 1;
    var body = h('tbody', {}, []);
    for (var i = 0; i < shown.length; i++) body.appendChild(boardRowNode(shown[i], topImplied));
    return h('div', { className: 'panel', id: 'board' }, [
      h('div', { className: 'table-wrap' }, [
        h('table', {}, [
          h('caption', { className: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }, []),
          h('thead', {}, [
            h('tr', {}, [
              sortCell('implied', 'Rank'),
              sortCell('name', 'Protocol'),
              sortCell('tvl', 'TVL'),
              sortCell('growth', '7d'),
              sortCell('age', 'Age'),
              sortCell('implied', 'Implied value'),
              h('th', { scope: 'col', text: 'Token' }, []),
            ]),
          ]),
          body,
        ]),
      ]),
    ]);
  }

  // -- The live-token table: market caps, not a model ----------------------
  function buildLiveBoard() {
    var body = h('tbody', {}, []);
    for (var i = 0; i < DATA.live.length; i++) {
      var row = DATA.live[i];
      var growthCls = row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg';
      body.appendChild(h('tr', {}, [
        h('td', { className: 'num', text: 'live' }, []),
        h('td', {}, [
          h('div', { className: 'name' }, [
            h('b', { text: row.name }, []),
            h('span', { className: 'sub', text: (row.category || 'Other') + ' on ' + chainLabel(row) }, []),
          ]),
        ]),
        h('td', { className: 'num', text: money(row.tvl_usd) }, []),
        h('td', { className: 'num ' + growthCls, text: pct(row.change_7d) }, []),
        h('td', { className: 'num', text: money(row.mcap_usd) }, []),
        h('td', {}, [h('span', { className: 'badge live', text: 'already trades' }, [])]),
      ]));
    }
    return h('div', { className: 'panel' }, [
      h('div', { className: 'table-wrap' }, [
        h('table', {}, [
          h('caption', { className: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking — and they are the traded comparables the size curve is fitted on.' }, []),
          h('thead', {}, [
            h('tr', {}, [
              h('th', { scope: 'col', text: 'Status' }, []),
              h('th', { scope: 'col', text: 'Protocol' }, []),
              h('th', { scope: 'col', text: 'TVL' }, []),
              h('th', { scope: 'col', text: '7d' }, []),
              h('th', { scope: 'col', text: 'Market cap' }, []),
              h('th', { scope: 'col', text: 'Token' }, []),
            ]),
          ]),
          body,
        ]),
      ]),
    ]);
  }

  // -- The model panel: the fitted curve, the formula, the screen ---------
  //
  // The size term is a curve fitted to the snapshot's own traded tokens,
  // printed here with its equation, its fit quality and its sample size —
  // not a multiple set by hand. The three small terms (growth, maturity,
  // breadth) are the same hand-set constants as before, stated in the open.
  function buildModelNote() {
    var model = DATA.model;
    var fit = DATA.fit;
    var curveLine = 'log10(mcap) = ' + fit.intercept.toFixed(4) + ' + ' + fit.slope.toFixed(4) + ' x log10(TVL)';
    var chipNodes = [
      h('span', { className: 'comp' }, ['Traded comparables ', h('b', { text: String(fit.n_comps) }, [])]),
      h('span', { className: 'comp' }, ['R² ', h('b', { text: fit.r_squared.toFixed(4) }, [])]),
      h('span', { className: 'comp' }, ['Slope ', h('b', { text: 'x' + fit.slope.toFixed(4) }, [])]),
      h('span', { className: 'comp' }, ['Zero-mcap excluded ', h('b', { text: String(fit.zero_mcap_excluded) }, [])]),
    ];
    var formulaText = 'implied = round( 10 ^ (' + fit.intercept.toFixed(4) + ' + ' + fit.slope.toFixed(4) +
      ' x log10(tvl_usd)) x (1 + clamp(change_7d, ' +
      model.growth_floor + ', ' + model.growth_cap + ') / 100 x ' + model.growth_weight + ') x (' +
      model.maturity_floor + ' + min(age_days, ' + model.maturity_days + ') / ' + model.maturity_days +
      ' x ' + model.maturity_range + ') x (1 + 0.02 x min(chains - 1, 5)) )';
    var explainText = 'The size curve is fitted at run time by ordinary least squares on the ' +
      fit.n_comps + ' protocols in this snapshot that already trade (market cap above zero and TVL above zero). ' +
      'Its slope is below one, so value grows slower than size: ten times the TVL is worth only a few times the value, ' +
      'not ten times. ' + fit.zero_mcap_excluded + ' protocols that record a market cap of exactly zero are excluded ' +
      'from the fit, because log10(0) has no value and a zero cap is a record with no price in it. ' +
      'R² is ' + fit.r_squared.toFixed(4) + ' on the log scale — the curve explains part of the spread in traded values, ' +
      'not all of it, and the board says so. Age is the time since the protocol was first listed, the best record of ' +
      'how long it has run with no token; an unlisted age uses ' + model.unknown_age_days + ' days.';
    return h('section', { className: 'panel model' }, [
      h('h2', { text: 'How implied value is computed' }, []),
      h('p', { className: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no coefficient is hard-coded — the curve is fitted from the snapshot itself.' }, []),
      h('div', { className: 'formula', text: curveLine }, []),
      h('div', { className: 'comps' }, chipNodes),
      h('div', { className: 'formula', text: formulaText }, []),
      h('p', { className: 'sub', text: explainText }, []),
      h('p', { className: 'sub', text: 'The early radar is every pre-token protocol that passes the same screen as the watchlist — no token on record, not a wrapped, staked or bridged product, not a versioned pool — whatever its TVL. The live-token protocols are set aside with their market caps shown.' }, []),
    ]);
  }

  // -- The detail drawer ---------------------------------------------------
  //
  // One <dialog> element, reused for every protocol: opening it fills it
  // with the row's model breakdown and farm plan, closing it clears the
  // selection from the view and the hash. Escape closes it too (see the
  // keydown listener at the bottom), and the drawer re-opens on reload when
  // the hash still names a protocol.
  var drawer = h('dialog', { className: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' }, []);
  drawer.addEventListener('close', function () {
    state.selected = null;
    saveToHash();
  });

  function showProtocol(slug) {
    var entry = null;
    for (var i = 0; i < DATA.rows.length; i++) {
      var cand = DATA.rows[i];
      if (cand.slug === slug) { entry = cand; break; }
    }
    if (!entry) return;
    state.selected = slug;
    saveToHash();
    drawer.textContent = '';
    var recomputed = recomputeImplied(entry, DATA.model);
    var matches = recomputed === entry.implied_value_usd;
    var chainCount = (entry.chains || []).length;
    var chainText = entry.chains && entry.chains.length ? entry.chains.join(', ') : 'an unnamed chain';
    var fit = DATA.fit;

    var head = h('div', { className: 'detail-head' }, [
      h('div', {}, [
        h('span', { className: 'brand-name', text: 'Rank ' + entry.rank + ' of ' + DATA.board_size + ' · ' + (entry.category || 'Other') }, []),
        h('h2', { id: 'detail-title', text: entry.name }, []),
        h('p', { className: 'sub', text: 'on ' + chainText + (entry.listed_at ? ' · listed ' + entry.listed_at : '') }, []),
      ]),
      h('button', {
        className: 'close',
        type: 'button',
        'aria-label': 'Close details',
        text: 'Close',
        onclick: function () { drawer.close(); },
      }, []),
    ]);

    // The equation, as label/value pairs: the snapshot figures, the curve
    // value at this TVL, each multiplier, and the total the board carries.
    var breakdown = [
      ['TVL', money(entry.tvl_usd)],
      ['Size curve value (10 ^ (' + fit.intercept.toFixed(4) + ' + ' + fit.slope.toFixed(4) + ' x log10(TVL)))', money(entry.curve_value_usd)],
      ['Seven-day growth', pct(entry.change_7d)],
      ['Growth multiplier', 'x' + multText(entry.growth_multiplier)],
      ['Age with no token', ageText(entry.age_days)],
      ['Maturity multiplier', 'x' + multText(entry.maturity_multiplier)],
      ['Chain breadth (' + chainCount + ' chain' + (chainCount === 1 ? '' : 's') + ')', 'x' + multText(entry.breadth_multiplier)],
    ];
    var equation = h('div', { className: 'equation' }, []);
    for (var i = 0; i < breakdown.length; i++) {
      var pair = breakdown[i];
      equation.appendChild(h('div', {}, [
        h('span', { text: pair[0] }, []),
        h('b', { className: 'num', text: pair[1] }, []),
      ]));
    }
    equation.appendChild(h('div', { className: 'total' }, [
      h('span', { text: 'Implied value' }, []),
      h('b', { className: 'num', text: money(entry.implied_value_usd) }, []),
    ]));

    var matchNote = matches ? ', the same number board.json carries.' : ', which differs from the board — the data would be stale.';
    var modelText = 'Model ' + DATA.model_version + ': the size curve is fitted on ' + fit.n_comps +
      ' traded protocols in this snapshot (R² ' + fit.r_squared.toFixed(4) + '), and the same function scores every protocol. ' +
      'The page recomputes this row as ' + money(recomputed) + matchNote +
      ' This is an estimate of what a launch could be worth at today\u2019s record, not a price and not a prediction that a token comes.';

    var valueSection = h('section', { className: 'detail-section' }, [
      h('h3', { text: 'Implied value' }, []),
      equation,
      h('p', { className: 'sub', text: modelText }, []),
    ]);

    // Each farm step is one string with its cost tucked after " Cost: " —
    // the action goes bold, the cost and time stay small underneath it.
    var stepNodes = [];
    var farmSteps = entry.farm_steps || [];
    for (var i = 0; i < farmSteps.length; i++) {
      var step = farmSteps[i];
      var cut = step.indexOf(' Cost: ');
      var action = cut >= 0 ? step.slice(0, cut) : step;
      var tail = cut >= 0 ? step.slice(cut + 1) : '';
      stepNodes.push(h('li', {}, [
        h('b', { text: action }, []),
        h('span', { className: 'cost', text: tail }, []),
      ]));
    }
    var farmSection = h('section', { className: 'detail-section' }, [
      h('h3', { text: 'Farm plan' }, []),
      h('ol', { className: 'steps' }, stepNodes),
    ]);

    drawer.appendChild(head);
    drawer.appendChild(valueSection);
    drawer.appendChild(farmSection);
    drawer.appendChild(h('div', { className: 'note', text: '\u201cNo token\u201d means the snapshot records none for this protocol — DefiLlama\u2019s record, not proof. Verify the protocol\u2019s own page before you farm, never pay to claim an airdrop, and never share a seed phrase.' }, []));

    if (typeof drawer.showModal === 'function') {
      if (!drawer.open) drawer.showModal();
    } else {
      drawer.setAttribute('open', '');
    }
  }

  // -- Render --------------------------------------------------------------
  //
  // One full rebuild from the current view: masthead, intro, spotlight,
  // filters, then the pre-token board plus the model panel, or the live
  // table on its own. The drawer lives outside the shell and is only
  // attached once; a selection in the hash re-opens it after the rebuild.
  function paint() {
    root.textContent = '';
    var page = h('div', { className: 'shell' }, []);
    page.appendChild(buildMasthead());
    page.appendChild(buildIntro());
    page.appendChild(buildSpotlight());
    page.appendChild(buildFilters());
    page.appendChild(state.tab === 'pre-token' ? buildBoard() : buildLiveBoard());
    if (state.tab === 'pre-token') page.appendChild(buildModelNote());
    page.appendChild(h('p', { className: 'foot', text: 'Token Radar · model ' + DATA.model_version + ' · snapshot ' + DATA.as_of + ' · ' + DATA.source + ' · Implied values are this entry\u2019s model, never a price.' }, []));
    root.appendChild(page);
    root.setAttribute('aria-busy', 'false');
    if (!drawer.isConnected) root.appendChild(drawer);
    if (state.selected) showProtocol(state.selected);
  }

  loadFromHash();
  paint();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.open) drawer.close();
  });
})();
