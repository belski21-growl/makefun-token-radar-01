// Token Radar — the dashboard's rendering code, round 2.
//
// The page is fed by data.js, which main.ts writes beside this folder as
// window.RADAR: the ranked board, the live-token set-aside, the category
// multiples (with, since round 2, how many live comparables set each one,
// whether it fell back to the global median, and how crowded its field is)
// and the model constants. This script turns that one object into the whole
// page — masthead, intro, top-three cards, filters, the sortable board
// table, the live-token table, the model explainer and the per-protocol
// detail drawer — and nothing else. It fetches nothing: every number and
// word on screen comes from the snapshot baked into data.js.
//
// One property of the page is worth stating up front. The detail drawer
// does not trust the board's implied values: it re-derives each row's
// implied value from the snapshot figures (TVL, the category's comparable
// multiple, the growth and maturity multipliers, the chain breadth) with
// the same four factors the model in lib/model.ts uses, and prints whether
// the re-derived number equals the one board.json carries —
// recomputeRow(row, DATA.model) === row.implied_value_usd —
// so a stale or altered board shows up in the open instead of hiding.
//
// Round 2 honesty note. "No token on record" is what the badge says now,
// and it means exactly that: the snapshot's DefiLlama record carries no
// token for the protocol. The record can lag — a protocol may already trade
// while its record carries no token — so the label is a statement about the
// record, never proof that no token exists.
(function () {
  'use strict';

  // The snapshot payload. Bail out silently when the data script never ran:
  // there is nothing to render and no error worth surfacing.
  const DATA = window.RADAR;
  if (!DATA) return;

  const mount = document.getElementById('app');

  // Everything the page remembers between renders: the search text, the two
  // dropdown filters, the TVL floor, which tab is showing, the sort key and
  // direction, and the slug of the protocol whose detail drawer is open.
  const state = {
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
  // Money is shown compactly ($404.0M, $141.4M, $12K) once it passes a
  // thousand dollars, and with the plain currency formatter below that.
  const usdPlain = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    const size = Math.abs(n);
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
  function recomputeRow(row, model) {
    const rawGrowth = row.change_7d == null ? 0 : row.change_7d;
    const clampedGrowth = Math.max(model.growth_floor, Math.min(model.growth_cap, rawGrowth));
    const growthFactor = 1 + (clampedGrowth / 100) * model.growth_weight;
    const ageDays = row.age_days == null ? model.unknown_age_days : row.age_days;
    const cappedAge = Math.min(Math.max(ageDays, 0), model.maturity_days);
    const maturityFactor = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
    const chainCount = (row.chains || []).length;
    const extraChains = Math.min(Math.max(chainCount - 1, 0), model.breadth_max_chains);
    const breadthFactor = 1 + extraChains * model.breadth_per_chain;
    const value = row.tvl_usd * row.comp_multiple * growthFactor * maturityFactor * breadthFactor;
    return Math.max(1, Math.round(value));
  }

  // -- Where a row's multiple comes from ----------------------------------
  //
  // Round 2: the dashboard no longer prints a bare multiple. data.js
  // carries, per category, how many live-token comparables set the multiple,
  // whether it fell back to the global median, and how crowded the
  // category's pre-token field is — so the drawer can say, for a Risk
  // Curators row, "Global median — Risk Curators has 1 live comparable"
  // instead of leaving the reader to guess why three curators share x0.1689.
  function compDetailFor(row) {
    const detail = DATA.comp_by_category_detail || {};
    return detail[row.category || 'Other'] || null;
  }

  function compBasisText(row) {
    const d = compDetailFor(row);
    const cat = row.category || 'Other';
    if (!d) return 'Category median — ' + cat;
    const countWord = d.comparables === 1 ? ' live comparable' : ' live comparables';
    const basis = d.fallback_global
      ? 'Global median — ' + cat + ' has ' + d.comparables + countWord
      : 'Category median — ' + cat + ' has ' + d.comparables + countWord;
    return basis + ' · crowd ' + d.crowd;
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
    const node = document.createElement(name);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === null || value === undefined) continue;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
    }
    if (kids) {
      for (const child of kids) {
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
          for (const inner of child) if (inner) node.appendChild(inner);
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
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    const q = params.get('q');
    if (q) state.q = q;
    const category = params.get('category');
    if (category) state.category = category;
    const chain = params.get('chain');
    if (chain) state.chain = chain;
    const tab = params.get('tab');
    if (tab) state.tab = tab;
    const picked = params.get('p');
    if (picked) state.selected = picked;
  }

  function writeHash() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    const next = params.toString();
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
    const needle = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (row) {
      if (state.category !== 'all' && row.category !== state.category) return false;
      if (state.chain !== 'all' && (row.chains || []).indexOf(state.chain) < 0) return false;
      if (state.minTvl > 0 && row.tvl_usd < state.minTvl) return false;
      if (!needle) return true;
      const haystack = [row.name, row.slug, row.category, (row.chains || []).join(' ')].join(' ').toLowerCase();
      return haystack.indexOf(needle) >= 0;
    });
  }

  function sortKey(row) {
    if (state.sort === 'name') return row.name.toLowerCase();
    if (state.sort === 'tvl') return row.tvl_usd;
    if (state.sort === 'growth') return row.change_7d === null ? -Infinity : row.change_7d;
    if (state.sort === 'age') return row.age_days === null ? Infinity : row.age_days;
    return row.implied_value_usd;
  }

  function sortedRows(list) {
    return list.slice().sort(function (a, b) {
      const av = sortKey(a);
      const bv = sortKey(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
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
    const top = DATA.rows[0];
    const floorM = Math.round(DATA.floor_usd / 1e6);
    const blurb = 'The watchlist is the floor: every protocol with at least $' + floorM +
      'M of TVL and no token on record. The early radar adds ' + DATA.early_size +
      ' more pre-token protocols below that floor, screened the same way — no wrapped, staked or bridged product of a token that already trades. Implied value is this entry\u2019s model, not a promise and not a prediction of a launch.';
    const facts = [
      ['Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size],
      ['Pre-token rows scored', String(DATA.board_size)],
      ['Early rows below the floor', String(DATA.early_size)],
      ['Live-token protocols set aside', String(DATA.live_size)],
      ['Top implied value', top ? fmtMoney(top.implied_value_usd) + ' — ' + top.name : 'n/a'],
    ];
    const factNodes = facts.map(function (pair) {
      return el('div', { className: 'fact' }, [
        el('span', { text: pair[0] }, []),
        el('b', { text: pair[1] }, []),
      ]);
    });
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
    const cards = [];
    const leaders = DATA.rows.slice(0, 3);
    for (const row of leaders) {
      cards.push(el('button', {
        className: 'spot-card',
        type: 'button',
        onclick: function () { openProtocol(row.slug); },
      }, [
        el('span', { className: 'rank', text: 'Rank ' + row.rank }, []),
        el('b', { text: row.name }, []),
        el('span', { className: 'implied', text: fmtMoney(row.implied_value_usd) }, []),
        el('span', { className: 'sub', text: (row.category || 'Other') + ' · TVL ' + fmtMoney(row.tvl_usd) + ' · ' + (row.chains || []).slice(0, 2).join(', ') }, []),
      ]));
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
    const categorySet = new Set();
    const chainSet = new Set();
    for (const row of DATA.rows) {
      categorySet.add(row.category || 'Other');
      for (const chain of row.chains || []) chainSet.add(chain);
    }
    const categories = Array.from(categorySet).sort();
    const chains = Array.from(chainSet).sort();

    const search = el('input', {
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

    const categoryOptions = [el('option', { value: 'all', text: 'All categories' }, [])];
    for (const c of categories) {
      categoryOptions.push(el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }, []));
    }
    const categorySelect = el('select', { id: 'category', 'aria-label': 'Filter by category' }, categoryOptions);
    categorySelect.addEventListener('change', function () {
      state.category = categorySelect.value;
      writeHash();
      render();
    });

    const chainOptions = [el('option', { value: 'all', text: 'All chains' }, [])];
    for (const c of chains) {
      chainOptions.push(el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }, []));
    }
    const chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' }, chainOptions);
    chainSelect.addEventListener('change', function () {
      state.chain = chainSelect.value;
      writeHash();
      render();
    });

    const tvlSteps = [['$50M+', 50000000], ['$100M+', 100000000], ['$250M+', 250000000], ['$500M+', 500000000]];
    const tvlOptions = [el('option', { value: '0', text: 'Any TVL' }, [])];
    for (const step of tvlSteps) {
      tvlOptions.push(el('option', { value: String(step[1]), text: step[0], selected: state.minTvl === step[1] ? 'selected' : null }, []));
    }
    const tvlSelect = el('select', { id: 'mintvl', 'aria-label': 'Minimum TVL' }, tvlOptions);
    tvlSelect.addEventListener('change', function () {
      state.minTvl = Number(tvlSelect.value);
      render();
    });

    const preTab = el('button', {
      type: 'button',
      'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false',
      text: 'Pre-token',
      onclick: function () { state.tab = 'pre-token'; render(); },
    }, []);
    const liveTab = el('button', {
      type: 'button',
      'aria-pressed': state.tab === 'live' ? 'true' : 'false',
      text: 'Live token',
      onclick: function () { state.tab = 'live'; render(); },
    }, []);

    const shown = state.tab === 'pre-token'
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
    const button = el('button', {
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
  function chainShort(row) {
    const chains = row.chains || [];
    return chains.length ? chains.slice(0, 2).join(', ') : 'an unnamed chain';
  }

  // -- One board row --------------------------------------------------------
  function boardRow(row, topValue) {
    const growthText = row.change_7d === null ? 'n/a' : fmtPct(row.change_7d);
    const growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
    const barWidth = Math.max(3, Math.round((row.implied_value_usd / topValue) * 100));
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
          el('span', { className: 'sub', text: (row.category || 'Other') + ' on ' + chainShort(row) }, []),
        ]),
      ]),
      el('td', { className: 'num', text: fmtMoney(row.tvl_usd) }, []),
      el('td', { className: 'num ' + growthClass, text: growthText }, []),
      el('td', { className: 'num', text: fmtAge(row.age_days) }, []),
      el('td', {}, [
        el('div', { className: 'implied' }, [
          el('div', { className: 'bar', 'aria-hidden': 'true' }, [
            el('i', { style: 'width:' + barWidth + '%' }, []),
          ]),
          el('span', { className: 'num', text: fmtMoney(row.implied_value_usd) }, []),
        ]),
      ]),
      el('td', {}, [el('span', { className: 'badge', text: 'no token on record' }, [])]),
    ]);
  }

  // -- The board table, or the empty state when nothing matches ------------
  function boardPanel() {
    const list = sortedRows(filteredRows());
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
    const topValue = DATA.rows[0].implied_value_usd || 1;
    const tbody = el('tbody', {}, []);
    for (const row of list) tbody.appendChild(boardRow(row, topValue));
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
              el('th', { scope: 'col', text: 'Token' }, []),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ]);
  }

  // -- The live-token table: market caps, not a model ----------------------
  function livePanel() {
    const tbody = el('tbody', {}, []);
    for (const row of DATA.live) {
      const growthClass = row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(el('tr', {}, [
        el('td', { className: 'num', text: 'live' }, []),
        el('td', {}, [
          el('div', { className: 'name' }, [
            el('b', { text: row.name }, []),
            el('span', { className: 'sub', text: (row.category || 'Other') + ' on ' + chainShort(row) }, []),
          ]),
        ]),
        el('td', { className: 'num', text: fmtMoney(row.tvl_usd) }, []),
        el('td', { className: 'num ' + growthClass, text: fmtPct(row.change_7d) }, []),
        el('td', { className: 'num', text: fmtMoney(row.mcap_usd) }, []),
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
    const m = DATA.model;
    // Round 2: the chips are drawn from the per-category detail, not just
    // the priced categories — so a category that fell back to the global
    // median shows up here too, with its comparable count and the arrow to
    // global. Sorted by multiple, then by how crowded the field is, so the
    // thinnest-backed multiple the board leans on (Risk Curators, n=1) is
    // visible instead of hidden behind the priced categories.
    const detail = DATA.comp_by_category_detail || {};
    const ranked = Object.keys(detail).sort(function (a, b) {
      const da = detail[a];
      const db = detail[b];
      if (db.multiple !== da.multiple) return db.multiple - da.multiple;
      if (db.crowd !== da.crowd) return db.crowd - da.crowd;
      return a < b ? -1 : a > b ? 1 : 0;
    }).slice(0, 10);
    const chips = ranked.map(function (c) {
      const d = detail[c];
      const suffix = ' · n=' + d.comparables + (d.fallback_global ? ' → global' : '') + ' · crowd ' + d.crowd;
      return el('span', { className: 'comp' }, [c + ' ', el('b', { text: '×' + d.multiple.toFixed(2) }, []), suffix]);
    });
    const formula = 'implied = round( tvl_usd x comp(category) x (1 + clamp(change_7d, ' +
      m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' +
      m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days +
      ' x ' + m.maturity_range + ') x (1 + 0.02 x min(chains - 1, 5)) )';
    const explainer = 'comp(category) is the median market-cap-per-TVL of the live-token protocols in the same category — what the market already pays per dollar of TVL for that kind of protocol — steadied toward the global median when the category has few comparables, discounted when many pre-token protocols crowd the same category, and eased past 0.80 on a curve that never passes 1.00, so two rich categories no longer tie at the cap. Categories with fewer than 3 live comparables use the global median of x' +
      DATA.comp_global.toFixed(2) + '. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days.';
    const caveat = 'One honesty note: “no token on record” means the snapshot\u2019s DefiLlama record carries no token for a protocol — the record can lag, so it is not proof that no token exists. A row can be misclassified when the record is out of date; check the protocol\u2019s own page before you farm.';
    return el('section', { className: 'panel model' }, [
      el('h2', { text: 'How implied value is computed' }, []),
      el('p', { className: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }, []),
      el('div', { className: 'formula', text: formula }, []),
      el('p', { className: 'sub', text: explainer }, []),
      el('div', { className: 'comps' }, chips),
      el('p', { className: 'sub', text: caveat }, []),
      el('p', { className: 'sub', text: 'The early radar is every pre-token protocol that passes the same screen as the watchlist — no token on record, not a wrapped, staked or bridged product, not a versioned pool — whatever its TVL. The live-token protocols are set aside with their market caps shown.' }, []),
    ]);
  }

  // -- The detail drawer ---------------------------------------------------
  //
  // One <dialog> element, reused for every protocol: opening it fills it
  // with the row's model breakdown and farm plan, closing it clears the
  // selection from the view and the hash. Escape closes it too (see the
  // keydown listener at the bottom), and the drawer re-opens on reload when
  // the hash still names a protocol.
  const detailDialog = el('dialog', { className: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' }, []);
  detailDialog.addEventListener('close', function () {
    state.selected = null;
    writeHash();
  });

  function openProtocol(slug) {
    let row = null;
    for (const candidate of DATA.rows) {
      if (candidate.slug === slug) { row = candidate; break; }
    }
    if (!row) return;
    state.selected = slug;
    writeHash();
    detailDialog.textContent = '';
    const recomputed = recomputeRow(row, DATA.model);
    const matches = recomputed === row.implied_value_usd;
    const chainCount = (row.chains || []).length;
    const chainText = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';

    const head = el('div', { className: 'detail-head' }, [
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
    // multiplier, where the multiple comes from, and the total the board
    // carries.
    const breakdown = [
      ['TVL', fmtMoney(row.tvl_usd)],
      ['Category multiple (' + (row.category || 'Other') + ')', '×' + fmtMult(row.comp_multiple)],
      ['Comparable basis', compBasisText(row), true],
      ['Seven-day growth', fmtPct(row.change_7d)],
      ['Growth multiplier', '×' + fmtMult(row.growth_multiplier)],
      ['Age with no token', fmtAge(row.age_days)],
      ['Maturity multiplier', '×' + fmtMult(row.maturity_multiplier)],
      ['Chain breadth (' + chainCount + ' chain' + (chainCount === 1 ? '' : 's') + ')', '×' + fmtMult(row.breadth_multiplier)],
    ];
    const equation = el('div', { className: 'equation' }, []);
    for (const pair of breakdown) {
      // The basis value is a sentence, not a number: it must wrap inside the
      // drawer, or its nowrap .num class stretches every equation row past
      // the viewport and hides the short values off-screen.
      const val = pair[2]
        ? el('b', { className: 'num', style: 'white-space: normal; text-align: right; max-width: 320px;', text: pair[1] }, [])
        : el('b', { className: 'num', text: pair[1] }, []);
      equation.appendChild(el('div', {}, [
        el('span', { text: pair[0] }, []),
        val,
      ]));
    }
    equation.appendChild(el('div', { className: 'total' }, [
      el('span', { text: 'Implied value' }, []),
      el('b', { className: 'num', text: fmtMoney(row.implied_value_usd) }, []),
    ]));

    const verdict = matches ? ', the same number board.json carries.' : ', which differs from the board — the data would be stale.';
    const modelNote = 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtMoney(recomputed) + verdict + ' This is an estimate of what a launch could be worth at today\u2019s record, not a price and not a prediction that a token comes.';

    const valueSection = el('section', { className: 'detail-section' }, [
      el('h3', { text: 'Implied value' }, []),
      equation,
      el('p', { className: 'sub', text: modelNote }, []),
    ]);

    // Each farm step is one string with its cost tucked after " Cost: " —
    // the action goes bold, the cost and time stay small underneath it.
    const stepNodes = [];
    for (const step of row.farm_steps || []) {
      const cut = step.indexOf(' Cost: ');
      const action = cut >= 0 ? step.slice(0, cut) : step;
      const tail = cut >= 0 ? step.slice(cut + 1) : '';
      stepNodes.push(el('li', {}, [
        el('b', { text: action }, []),
        el('span', { className: 'cost', text: tail }, []),
      ]));
    }
    const farmSection = el('section', { className: 'detail-section' }, [
      el('h3', { text: 'Farm plan' }, []),
      el('ol', { className: 'steps' }, stepNodes),
    ]);

    detailDialog.appendChild(head);
    detailDialog.appendChild(valueSection);
    detailDialog.appendChild(farmSection);
    detailDialog.appendChild(el('div', { className: 'note', text: '\u201cNo token on record\u201d means the snapshot records none for this protocol — DefiLlama\u2019s record can lag, so it is not proof that no token exists. Verify the protocol\u2019s own page before you farm, never pay to claim an airdrop, and never share a seed phrase.' }, []));

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
    mount.textContent = '';
    const shell = el('div', { className: 'shell' }, []);
    shell.appendChild(masthead());
    shell.appendChild(intro());
    shell.appendChild(spotlight());
    shell.appendChild(filters());
    shell.appendChild(state.tab === 'pre-token' ? boardPanel() : livePanel());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(el('p', { className: 'foot', text: 'Token Radar · model ' + DATA.model_version + ' · snapshot ' + DATA.as_of + ' · ' + DATA.source + ' · Implied values are this entry\u2019s model, never a price.' }, []));
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!detailDialog.isConnected) mount.appendChild(detailDialog);
    if (state.selected) openProtocol(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && detailDialog.open) detailDialog.close();
  });
})();
