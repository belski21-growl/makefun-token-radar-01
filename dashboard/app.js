// Token Radar — Dashboard for radar-4 model (Round 3).
//
// This script renders the entire page from window.RADAR (injected via data.js).
// It builds: masthead, KPI strip, method & validation panel, intro, spotlight,
// filters (search, category, chain, verdict, TVL, sort), sortable board table,
// live-token table, best-farms strip, model explainer, and the per-protocol
// detail drawer with waterfall, comparables, and economics box.
//
// The detail drawer re-derives each row's implied value from DATA.fit and the
// row's own fields (TVL, family_offset, kept_terms, odds) so a stale board
// shows up as a mismatch instead of hiding silently.
(function () {
  'use strict';

  // The snapshot payload. Bail out silently when the data script never ran.
  const DATA = window.RADAR;
  if (!DATA) return;

  const mount = document.getElementById('app');

  // View state persisted in the URL hash.
  const state = {
    q: '',
    category: 'all',
    chain: 'all',
    verdict: 'all',
    minTvl: 0,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
  };

  // -- Number formatting -------------------------------------------------
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

  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  function fmtMult(n) {
    return (Math.round(n * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  }

  // -- Radar-4 recompute: implied from curve × family_offset × kept_terms × odds --
  //
  // value_if_launches = 10^(fit.a + fit.b * log10(TVL)) * family_offset * ∏kept_terms
  // implied = max(1, round(value_if_launches * odds))
  //
  // This must equal row.implied_value_usd for all 198 rows (0 mismatches).
  function recomputeRow(row) {
    const fit = DATA.fit;
    const termsMult = Object.values(row.kept_terms || {}).reduce((acc, v) => acc * v, 1.0);
    const curveValue = Math.pow(10, fit.a + fit.b * Math.log10(row.tvl_usd));
    const valueIfLaunches = curveValue * (row.family_offset || 1) * termsMult;
    const implied = Math.max(1, Math.round(valueIfLaunches * (row.odds || 0)));
    return implied;
  }

  // -- Where a row's multiple comes from ----------------------------------
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

  // -- Tiny element builder -----------------------------------------------
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

  // -- URL hash -----------------------------------------------------------
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
    const verdict = params.get('verdict');
    if (verdict) state.verdict = verdict;
    const tab = params.get('tab');
    if (tab) state.tab = tab;
    const sort = params.get('sort');
    if (sort) state.sort = sort;
    const dir = params.get('dir');
    if (dir) state.dir = parseInt(dir, 10);
    const picked = params.get('p');
    if (picked) state.selected = picked;
  }

  function writeHash() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', String(state.dir));
    if (state.selected) params.set('p', state.selected);
    const next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // -- Row filtering & sorting --------------------------------------------
  function filteredRows() {
    const needle = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (row) {
      if (state.category !== 'all' && row.category !== state.category) return false;
      if (state.chain !== 'all' && (row.chains || []).indexOf(state.chain) < 0) return false;
      if (state.verdict !== 'all' && row.econ.verdict !== state.verdict.toUpperCase()) return false;
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
    if (state.sort === 'net') return row.econ.expected_net;
    if (state.sort === 'netph') return row.econ.net_per_hour;
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

  // -- KPI Strip -----------------------------------------------------------
  function kpiStrip() {
    const v = DATA.verdict_counts || {};
    const fit = DATA.fit || {};
    const validation = DATA.validation || {};
    const odds = DATA.odds || {};

    const kpis = [
      ['Board rows', String(DATA.board_size)],
      ['Watchlist', String(DATA.watchlist_size)],
      ['Early radar', String(DATA.early_size)],
      ['Live set aside', String(DATA.live_size)],
      ['Fitted: a', fit.a?.toFixed(4) ?? 'n/a'],
      ['Fitted: b', fit.b?.toFixed(4) ?? 'n/a'],
      ['R²', fit.r2?.toFixed(4) ?? 'n/a'],
      ['LOO miss (curve)', validation.loo_curve_median_miss?.toFixed(2) ?? 'n/a'],
      ['LOO miss (flat)', validation.loo_flat_median_miss?.toFixed(2) ?? 'n/a'],
      ['Within 3× (curve)', ((validation.within3x_curve || 0) * 100).toFixed(1) + '%'],
      ['Within 3× (flat)', ((validation.within3x_flat || 0) * 100).toFixed(1) + '%'],
      ['WF cut', validation.walkforward?.cut_date ?? 'n/a'],
      ['WF n_train', String(validation.walkforward?.n_train ?? 'n/a')],
      ['WF n_test', String(validation.walkforward?.n_test ?? 'n/a')],
      ['WF miss (curve)', validation.walkforward?.miss_curve?.toFixed(2) ?? 'n/a'],
      ['WF miss (flat)', validation.walkforward?.miss_flat?.toFixed(2) ?? 'n/a'],
      ['Band P25–P75', ((validation.band_hold?.p25_75 || 0) * 100).toFixed(1) + '%'],
      ['Band P10–P90', ((validation.band_hold?.p10_90 || 0) * 100).toFixed(1) + '%'],
      ['AUC', odds.auc?.toFixed(3) ?? 'n/a'],
      ['Base rate', ((odds.base_rate || 0) * 100).toFixed(1) + '%'],
      ['ROBUST', String(v.robust ?? 0)],
      ['FARM', String(v.farm ?? 0)],
      ['THIN', String(v.thin ?? 0)],
      ['MARGINAL', String(v.marginal ?? 0)],
      ['SKIP', String(v.skip ?? 0)],
    ];

    return el('section', { className: 'kpi-strip' }, [
      el('h2', { text: 'KPIs & Validation' }, []),
      el('div', { className: 'kpi-grid' }, kpis.map(([label, value]) =>
        el('div', { className: 'kpi' }, [
          el('span', { className: 'kpi-label', text: label }, []),
          el('span', { className: 'kpi-value', text: value }, []),
        ])
      )),
    ]);
  }

  // -- Method & Validation Panel -------------------------------------------
  function methodPanel() {
    const fit = DATA.fit || {};
    const validation = DATA.validation || {};
    const odds = DATA.odds || {};

    // Ablation table
    const ablation = validation.ablation || [];
    const ablationRows = ablation.map(step =>
      el('tr', {}, [
        el('td', { text: step.label }, []),
        el('td', { className: 'num', text: step.loo_median_miss?.toFixed(4) ?? 'n/a' }, []),
        el('td', { className: 'num', text: ((step.within3x_pct || 0) * 100).toFixed(2) + '%' }, []),
        el('td', { className: 'num', text: step.walkforward_miss?.toFixed(4) ?? 'n/a' }, []),
        el('td', { className: 'num', text: step.kept ? 'Yes' : 'No' }, []),
        el('td', { text: step.note || '' }, []),
      ])
    );

    // Odds buckets table
    const oddsBuckets = odds.buckets || [];
    const oddsRows = oddsBuckets.map(b =>
      el('tr', {}, [
        el('td', { text: b.label }, []),
        el('td', { className: 'num', text: String(b.n) }, []),
        el('td', { className: 'num', text: String(b.k) }, []),
        el('td', { className: 'num', text: b.odds?.toFixed(6) ?? 'n/a' }, []),
      ])
    );

    return el('section', { className: 'panel method' }, [
      el('h2', { text: 'Method & Validation (radar-4)' }, []),
      el('p', { className: 'sub', text: 'All numbers derived from the sealed snapshot; no hand-tuning.' }, []),

      // Fitted equation
      el('div', { className: 'formula' }, [
        el('strong', { text: 'Fitted curve (Huber IRLS):' }, []),
        el('br', {}, []),
        'log₁₀(value_if_launches) = ' + (fit.a?.toFixed(4) ?? 'n/a') + ' + ' + (fit.b?.toFixed(4) ?? 'n/a') + ' × log₁₀(TVL) + log₁₀(family_offset) + ∑log₁₀(kept_terms)',
        el('br', {}), el('br', {}),
        'value_if_launches = 10^(a + b·log₁₀(TVL)) × family_offset × ∏kept_terms',
        el('br', {}),
        'implied = max(1, round(value_if_launches × odds))',
        el('br', {}), el('br', {}),
        'a = ' + (fit.a?.toFixed(4) ?? 'n/a') + ', b = ' + (fit.b?.toFixed(4) ?? 'n/a') + ', R² = ' + (fit.r2?.toFixed(4) ?? 'n/a') +
        ', n_comps = ' + (fit.n_comps ?? 'n/a') +
        ', excluded (mcap=0): ' + (fit.n_excluded_mcap0 ?? 'n/a') +
        ', excluded (CEX): ' + (fit.n_excluded_cex ?? 'n/a'),
      ]),

      // LOO & Walk-forward
      el('div', { className: 'validation-grid' }, [
        el('div', { className: 'val-card' }, [
          el('h3', { text: 'LOO Cross-Validation' }, []),
          el('p', { text: 'Curve median miss: ' + (validation.loo_curve_median_miss?.toFixed(2) ?? 'n/a') + '×' }, []),
          el('p', { text: 'Flat median miss: ' + (validation.loo_flat_median_miss?.toFixed(2) ?? 'n/a') + '×' }, []),
          el('p', { text: 'Within 3× (curve): ' + ((validation.within3x_curve || 0) * 100).toFixed(1) + '%' }, []),
          el('p', { text: 'Within 3× (flat): ' + ((validation.within3x_flat || 0) * 100).toFixed(1) + '%' }, []),
        ]),
        el('div', { className: 'val-card' }, [
          el('h3', { text: 'Walk-Forward' }, []),
          el('p', { text: 'Cut: ' + (validation.walkforward?.cut_date ?? 'n/a') }, []),
          el('p', { text: 'Train: ' + (validation.walkforward?.n_train ?? 'n/a') + ' / Test: ' + (validation.walkforward?.n_test ?? 'n/a') }, []),
          el('p', { text: 'Curve miss: ' + (validation.walkforward?.miss_curve?.toFixed(2) ?? 'n/a') + '×' }, []),
          el('p', { text: 'Flat miss: ' + (validation.walkforward?.miss_flat?.toFixed(2) ?? 'n/a') + '×' }, []),
        ]),
        el('div', { className: 'val-card' }, [
          el('h3', { text: 'Band-Hold' }, []),
          el('p', { text: 'P25–P75: ' + ((validation.band_hold?.p25_75 || 0) * 100).toFixed(1) + '% (nominal 50%)' }, []),
          el('p', { text: 'P10–P90: ' + ((validation.band_hold?.p10_90 || 0) * 100).toFixed(1) + '% (nominal 80%)' }, []),
        ]),
        el('div', { className: 'val-card' }, [
          el('h3', { text: 'Launch Odds' }, []),
          el('p', { text: 'AUC: ' + (odds.auc?.toFixed(3) ?? 'n/a') }, []),
          el('p', { text: 'Base rate: ' + ((odds.base_rate || 0) * 100).toFixed(1) + '%' }, []),
          el('p', { text: 'Unknown age: ' + (odds.unknown_age ?? 'n/a') }, []),
        ]),
      ]),

      // Ablation table
      el('h3', { text: 'Ablation (7 steps)' }, []),
      el('div', { className: 'table-wrap' }, [
        el('table', { className: 'ablation-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Step' }, []),
              el('th', { scope: 'col', className: 'num', text: 'LOO miss' }, []),
              el('th', { scope: 'col', className: 'num', text: 'Within 3×' }, []),
              el('th', { scope: 'col', className: 'num', text: 'WF miss' }, []),
              el('th', { scope: 'col', className: 'num', text: 'Kept' }, []),
              el('th', { scope: 'col', text: 'Note' }, []),
            ]),
          ]),
          el('tbody', {}, ablationRows),
        ]),
      ]),

      // Odds buckets table
      el('h3', { text: 'Odds Buckets (smoothed: (k + 5×base) / (n + 5))' }, []),
      el('div', { className: 'table-wrap' }, [
        el('table', { className: 'odds-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Age bucket' }, []),
              el('th', { scope: 'col', className: 'num', text: 'n' }, []),
              el('th', { scope: 'col', className: 'num', text: 'k' }, []),
              el('th', { scope: 'col', className: 'num', text: 'Odds' }, []),
            ]),
          ]),
          el('tbody', {}, oddsRows),
        ]),
      ]),
    ]);
  }

  // -- Intro ---------------------------------------------------------------
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

  // -- Spotlight: top three ------------------------------------------------
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

  // -- Filters -------------------------------------------------------------
  function filters() {
    const categorySet = new Set();
    const chainSet = new Set();
    for (const row of DATA.rows) {
      categorySet.add(row.category || 'Other');
      for (const chain of row.chains || []) chainSet.add(chain);
    }
    const categories = Array.from(categorySet).sort();
    const chains = Array.from(chainSet).sort();

    const verdicts = ['all', 'ROBUST', 'FARM', 'THIN', 'MARGINAL', 'SKIP'];

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

    const verdictOptions = [];
    for (const v of verdicts) {
      const label = v === 'all' ? 'All verdicts' : v;
      verdictOptions.push(el('option', { value: v, text: label, selected: v === state.verdict ? 'selected' : null }, []));
    }
    const verdictSelect = el('select', { id: 'verdict', 'aria-label': 'Filter by verdict' }, verdictOptions);
    verdictSelect.addEventListener('change', function () {
      state.verdict = verdictSelect.value;
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
        el('label', { for: 'verdict', text: 'Verdict' }, []),
        verdictSelect,
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

  // -- Sort head -----------------------------------------------------------
  function sortHead(key, label) {
    const button = el('button', {
      type: 'button',
      onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        writeHash();
        render();
      },
    }, [label]);
    if (state.sort === key) {
      button.appendChild(el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }, []));
    }
    return el('th', { scope: 'col' }, [button]);
  }

  function chainShort(row) {
    const chains = row.chains || [];
    return chains.length ? chains.slice(0, 2).join(', ') : 'an unnamed chain';
  }

  // -- Board row -----------------------------------------------------------
  function boardRow(row, topValue) {
    const growthText = row.change_7d === null ? 'n/a' : fmtPct(row.change_7d);
    const growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
    const barWidth = Math.max(3, Math.round((row.implied_value_usd / topValue) * 100));
    const verdictClass = 'verdict-' + (row.econ.verdict || 'SKIP').toLowerCase();

    // Implied value with band and rank range
    const bandText = 'P25–P75: ' + fmtMoney(row.band_lo) + ' – ' + fmtMoney(row.band_hi);
    const rankText = 'Rank range: #' + row.rank_lo + ' – #' + row.rank_hi;

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
      el('td', { className: 'num verdict-cell ' + verdictClass, text: row.econ.verdict }, []),
      el('td', {}, [
        el('div', { className: 'implied' }, [
          el('div', { className: 'bar', 'aria-hidden': 'true' }, [
            el('i', { style: 'width:' + barWidth + '%' }, []),
          ]),
          el('span', { className: 'num', text: fmtMoney(row.implied_value_usd) }, []),
          el('div', { className: 'band-info' }, [
            el('span', { className: 'band-text', text: bandText }, []),
            el('span', { className: 'rank-text', text: rankText }, []),
          ]),
        ]),
      ]),
      el('td', { className: 'num' + (row.econ.expected_net < 0 ? ' neg' : ''), text: fmtMoney(row.econ.expected_net) }, []),
      el('td', { className: 'num' + (row.econ.net_per_hour < 0 ? ' neg' : ''), text: '$' + row.econ.net_per_hour.toFixed(2) + '/hr' }, []),
      el('td', {}, [el('span', { className: 'badge', text: 'no token on record' }, [])]),
    ]);
  }

  // -- Board panel ---------------------------------------------------------
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
              state.verdict = 'all';
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
          el('caption', { className: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its waterfall, comparables, and farm economics.' }, []),
          el('thead', {}, [
            el('tr', {}, [
              sortHead('implied', 'Rank'),
              sortHead('name', 'Protocol'),
              sortHead('tvl', 'TVL'),
              sortHead('growth', '7d %'),
              sortHead('verdict', 'Verdict'),
              sortHead('implied', 'Implied value'),
              sortHead('net', 'Expected net'),
              sortHead('netph', 'Net/hr'),
              el('th', { scope: 'col', text: 'Token' }, []),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ]);
  }

  // -- Live panel ----------------------------------------------------------
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

  // -- Model panel (category multiples) ------------------------------------
  function modelPanel() {
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
    const explainer = 'comp(category) is the median market-cap-per-TVL of the live-token protocols in the same category — what the market already pays per dollar of TVL for that kind of protocol — steadied toward the global median when the category has few comparables, discounted when many pre-token protocols crowd the same category, and eased past 0.80 on a curve that never passes 1.00, so two rich categories no longer tie at the cap. Categories with fewer than 3 live comparables use the global median of x' +
      DATA.comp_global.toFixed(2) + '.';
    const caveat = 'One honesty note: \u201cno token on record\u201d means the snapshot\u2019s DefiLlama record carries no token for a protocol — the record can lag, so it is not proof that no token exists. A row can be misclassified when the record is out of date; check the protocol\u2019s own page before you farm.';
    return el('section', { className: 'panel model' }, [
      el('h2', { text: 'Category Comparable Multiples' }, []),
      el('p', { className: 'sub', text: 'Each category\'s multiple comes from live-token protocols in that category, with shrinkage and crowding adjustments.' }, []),
      el('div', { className: 'comps' }, chips),
      el('p', { className: 'sub', text: explainer }, []),
      el('p', { className: 'sub', text: caveat }, []),
      el('p', { className: 'sub', text: 'The early radar is every pre-token protocol that passes the same screen as the watchlist — no token on record, not a wrapped, staked or bridged product, not a versioned pool — whatever its TVL. The live-token protocols are set aside with their market caps shown.' }, []),
    ]);
  }

  // -- Best Farms Strip ----------------------------------------------------
  function bestFarmsStrip() {
    const farms = DATA.best_farms || [];
    if (farms.length === 0) return null;

    const items = farms.map((farm, i) =>
      el('button', {
        className: 'farm-card',
        type: 'button',
        onclick: function () { openProtocol(farm.slug); },
      }, [
        el('span', { className: 'farm-rank', text: '#' + (i + 1) }, []),
        el('b', { text: farm.name }, []),
        el('span', { className: 'farm-netph', text: '$' + farm.net_per_hour.toFixed(2) + '/hr' }, []),
        el('span', { className: 'farm-net', text: 'exp. net $' + farm.expected_net.toFixed(2) }, []),
      ])
    );

    return el('section', { className: 'best-farms', 'aria-label': 'Best farms by net per hour' }, [
      el('h2', { text: 'Best Farms Next' }, []),
      el('p', { className: 'sub', text: 'Top 5 FARM/THIN protocols by net per hour at $1,000 deposit. Click to open detail.' }, []),
      el('div', { className: 'farm-grid' }, items),
    ]);
  }

  // -- Detail Drawer -------------------------------------------------------
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

    const recomputed = recomputeRow(row);
    const matches = recomputed === row.implied_value_usd;

    const chainText = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';

    // Header
    const head = el('div', { className: 'detail-head' }, [
      el('div', {}, [
        el('span', { className: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · ' + (row.category || 'Other') }, []),
        el('h2', { id: 'detail-title', text: row.name }, []),
        el('p', { className: 'sub', text: 'on ' + chainText + (row.econ.hold_days ? ' · hold ' + row.econ.hold_days + 'd' : '') }, []),
      ]),
      el('button', {
        className: 'close',
        type: 'button',
        'aria-label': 'Close details',
        text: 'Close',
        onclick: function () { detailDialog.close(); },
      }, []),
    ]);

    // Waterfall breakdown
    const fit = DATA.fit;
    const termsMult = Object.values(row.kept_terms || {}).reduce((acc, v) => acc * v, 1.0);
    const curveValue = Math.pow(10, fit.a + fit.b * Math.log10(row.tvl_usd));
    const familyOffset = row.family_offset || 1;
    const valueIfLaunches = curveValue * familyOffset * termsMult;
    const implied = Math.max(1, Math.round(valueIfLaunches * (row.odds || 0)));

    const waterfallSteps = [
      ['Curve value (10^(a+b·log₁₀(TVL)))', fmtMoney(Math.round(curveValue))],
      ['× Family offset (' + fmtMult(familyOffset) + ')', fmtMoney(Math.round(curveValue * familyOffset))],
    ];

    if (Object.keys(row.kept_terms || {}).length > 0) {
      for (const [term, mult] of Object.entries(row.kept_terms)) {
        waterfallSteps.push(['× Kept term: ' + term + ' (' + fmtMult(mult) + ')', fmtMoney(Math.round(curveValue * familyOffset * mult))]);
      }
    } else {
      waterfallSteps.push(['× Kept terms', 'none kept']);
    }

    waterfallSteps.push(['Value if launches', fmtMoney(Math.round(valueIfLaunches))]);
    waterfallSteps.push(['× Odds (' + (row.odds || 0).toFixed(4) + ')', fmtMoney(implied)]);

    const waterfall = el('div', { className: 'waterfall' }, []);
    for (const [label, value] of waterfallSteps) {
      waterfall.appendChild(el('div', { className: 'waterfall-row' }, [
        el('span', { className: 'waterfall-label', text: label }, []),
        el('span', { className: 'waterfall-value num', text: value }, []),
      ]));
    }

    // Comparables
    const compRows = (row.nearest || []).map(comp =>
      el('tr', {}, [
        el('td', { text: comp.name }, []),
        el('td', { className: 'num', text: fmtMoney(comp.tvl_usd) }, []),
        el('td', { className: 'num', text: fmtMoney(comp.mcap_usd) }, []),
      ])
    );

    const comparables = el('div', { className: 'comparables' }, [
      el('h4', { text: 'Nearest Comparables (by TVL)' }, []),
      el('div', { className: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Protocol' }, []),
              el('th', { scope: 'col', className: 'num', text: 'TVL' }, []),
              el('th', { scope: 'col', className: 'num', text: 'Market Cap' }, []),
            ]),
          ]),
          el('tbody', {}, compRows),
        ]),
      ]),
    ]);

    // Band & Rank Range
    const bandRank = el('div', { className: 'band-rank' }, [
      el('h4', { text: 'Uncertainty & Rank Range' }, []),
      el('div', { className: 'band-rank-grid' }, [
        el('div', { className: 'band-item' }, [
          el('span', { className: 'band-label', text: 'P25–P75 Band' }, []),
          el('span', { className: 'band-value num', text: fmtMoney(row.band_lo) + ' – ' + fmtMoney(row.band_hi) }, []),
        ]),
        el('div', { className: 'band-item' }, [
          el('span', { className: 'band-label', text: 'P10–P90 Band' }, []),
          el('span', { className: 'band-value num', text: fmtMoney(row.band_lo90) + ' – ' + fmtMoney(row.band_hi90) }, []),
        ]),
        el('div', { className: 'band-item' }, [
          el('span', { className: 'band-label', text: 'Bootstrap Rank Range' }, []),
          el('span', { className: 'band-value num', text: '#' + row.rank_lo + ' – #' + row.rank_hi }, []),
        ]),
      ]),
    ]);

    // Economics Box
    const econ = row.econ;
    const verdict = econ.verdict;
    const isSkip = verdict === 'SKIP';

    const econRows = [
      ['Expected slice (10% drop × $1000/TVL × implied)', fmtMoney(econ.slice)],
      ['Gas (setup + weekly × weeks + 2nd chain + claim)', '$' + econ.gas.toFixed(2)],
      ['  Setup gas ($' + econ.gas_setup + (econ.gas_setup >= 8 ? ' ≥$150 plan' : ' <$150 plan') + ')', ''],
      ['  Weekly gas ($2 × ' + econ.weeks + ' weeks)', '$' + econ.gas_weekly.toFixed(2)],
      ['  Second chain', econ.gas_second_chain > 0 ? '$' + econ.gas_second_chain.toFixed(2) : '—'],
      ['  Claim', '$' + econ.gas_claim.toFixed(2)],
      ['T-bill forgone (4% × $1000 × ' + econ.hold_days + 'd/365)', '$' + econ.tbill.toFixed(2)],
      ['Slice if launches (slice / odds)', fmtMoney(econ.net_launch + econ.gas + econ.tbill)],
      ['Net if launches (sliceLaunch − gas − T-bill)', fmtMoney(econ.net_launch)],
      ['Expected net (slice − gas − T-bill)', fmtMoney(econ.expected_net)],
      ['Break-even odds % ((gas+T-bill)/sliceLaunch × 100)', econ.breakeven_pct >= 100000 ? '>100000%' : econ.breakeven_pct.toFixed(2) + '%'],
      ['Hands-on hours (setup + weekly×weeks + 2nd chain + claim + log)', econ.hours.toFixed(2) + 'h'],
      ['Net per hour (expected net / hours)', '$' + econ.net_per_hour.toFixed(2) + '/hr'],
      ['Verdict', verdict],
    ];

    const econBox = el('div', { className: 'econ-box' }, [
      el('h4', { text: 'Farm Economics (at $1,000 deposit)' }, []),
      el('table', { className: 'econ-table' }, [
        el('tbody', {}, econRows.map(([label, value]) =>
          el('tr', {}, [
            el('td', { text: label }, []),
            el('td', { className: 'num' + (value && value.toString().startsWith('$') && parseFloat(value.replace(/[$,]/g, '')) < 0 ? ' neg' : ''), text: value }, []),
          ])
        )),
      ]),
    ]);

    // SKIP note
    const skipNote = isSkip
      ? el('p', { className: 'skip-note' }, [
          'Skip: expected net is negative at a $1,000 deposit — the slice is too small against gas + T-bill.'
        ])
      : null;

    // Model note
    const modelNote = 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtMoney(recomputed) + (matches ? ', the same number board.json carries.' : ', which differs from the board — the data would be stale.') + ' This is an estimate of what a launch could be worth at today\u2019s record, not a price and not a prediction that a token comes.';

    // Farm steps
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
      el('h3', { text: 'Farm Plan' }, []),
      el('ol', { className: 'steps' }, stepNodes),
    ]);

    detailDialog.appendChild(head);
    detailDialog.appendChild(el('section', { className: 'detail-section' }, [
      el('h3', { text: 'Implied Value Waterfall' }, []),
      waterfall,
      el('p', { className: 'sub', text: modelNote }, []),
    ]));
    detailDialog.appendChild(el('section', { className: 'detail-section' }, [comparables]));
    detailDialog.appendChild(el('section', { className: 'detail-section' }, [bandRank]));
    detailDialog.appendChild(el('section', { className: 'detail-section' }, [econBox]));
    if (skipNote) detailDialog.appendChild(skipNote);
    detailDialog.appendChild(el('div', { className: 'note', text: '\u201cNo token on record\u201d means the snapshot records none for this protocol — DefiLlama\u2019s record can lag, so it is not proof that no token exists. Verify the protocol\u2019s own page before you farm, never pay to claim an airdrop, and never share a seed phrase.' }, []));
    detailDialog.appendChild(farmSection);

    if (typeof detailDialog.showModal === 'function') {
      if (!detailDialog.open) detailDialog.showModal();
    } else {
      detailDialog.setAttribute('open', '');
    }
  }

  // -- Render --------------------------------------------------------------
  function render() {
    mount.textContent = '';
    const shell = el('div', { className: 'shell' }, []);
    shell.appendChild(masthead());
    shell.appendChild(kpiStrip());
    shell.appendChild(methodPanel());
    shell.appendChild(intro());
    shell.appendChild(spotlight());
    shell.appendChild(filters());
    const bestFarms = bestFarmsStrip();
    if (bestFarms) shell.appendChild(bestFarms);
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
