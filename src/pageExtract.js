/**
 * Runs INSIDE the product page (via page.evaluate).
 *
 * Reads window.configuratorConfig (the whole configurator tree that the Magento
 * `/configurator/ajax/start/` call injects) and returns a normalized record.
 *
 * The start config only ships the option lists for the FIRST steps (slab, config
 * type). Later steps — swing direction / frame, casing, extensions, hinges,
 * handles, locksets, locks, pre-hanging — arrive empty and are populated by the
 * server in the `/configurator/ajax/` responses as you reach them. So to get the
 * full catalog we "harvest": replay the site's own POSTs (encoded with the page's
 * jQuery.param, byte-for-byte identical to the widget) and collect every option
 * list the responses expose, then merge them back into the tree.
 *
 * harvestMode:
 *   'none'     – tree only (fastest, ~1 page load, no configurator POSTs)
 *   'path'     – one default walk. Fills frame/hinges/handles/locksets/… along the
 *                recommended build. ~10–15 POSTs. Default.
 *   'branches' – 'path' + bounded divergence at each decision step to also collect
 *                alternate branches (american/AGB handles, LH/RH lockset variants).
 *                More complete, more requests (capped by maxBranchWalks).
 *
 * Everything is self-contained: page.evaluate serializes this function, so it may
 * only reference its `opts` argument and browser globals (window, document, jQuery).
 *
 * @param {{ harvestMode:'none'|'path'|'branches', buildBom:boolean,
 *           walkTimeoutMs:number, maxBranchWalks:number }} opts
 */
export async function pageExtract(opts) {
    const harvestMode = opts.harvestMode || 'path';
    const buildBom = opts.buildBom !== false;
    const walkTimeoutMs = opts.walkTimeoutMs || 45000;
    const maxBranchWalks = opts.maxBranchWalks || 14;
    const cc = window.configuratorConfig;

    // ---- helpers -----------------------------------------------------------
    const num = (v) => (v === null || v === undefined || v === '' ? null : (isNaN(+v) ? v : +v));
    const price = (it) => num(it && (it.catalog_price ?? it.price ?? it.absolute_price));
    const text = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const idOf = (it) => String((it && (it.entity_id ?? it.id)) ?? '');

    const optSummary = (it) => {
        if (!it || typeof it !== 'object') return null;
        return {
            id: it.entity_id ?? it.id ?? null,
            code: it.code ?? null,
            name: it.name ?? it.description ?? null,
            sku: it.sku ?? null,
            article: it.article ?? null,
            price: price(it),
            image: it.image_url ?? it.image ?? it.small_image ?? null,
            targetUrl: it.auto
                ? '/' + (it.auto.rel_url_path || it.auto.url_path || '')
                : (it.url_path ? '/' + it.url_path : null),
        };
    };

    const flattenListRaw = (list) => {
        const out = [];
        if (list && typeof list === 'object') {
            for (const gk of Object.keys(list)) {
                const g = list[gk];
                if (g && typeof g === 'object') for (const id of Object.keys(g)) out.push({ group: gk, it: g[id] });
            }
        }
        return out;
    };
    const optionsOf = (step) => flattenListRaw(step && step.list).map(({ group, it }) => {
        const o = optSummary(it);
        if (o) o.group = group;
        return o;
    }).filter(Boolean);

    // ---- base product info (works even without a configurator) --------------
    const productId =
        (document.querySelector('#configuratorProductId') || {}).getAttribute?.('data-id')
        || (cc && cc.wrapper_id) || null;

    let basePrice = null;
    try {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            const j = JSON.parse(s.textContent);
            const arr = Array.isArray(j) ? j : [j];
            for (const node of arr) {
                const offers = node && (node.offers || (node['@graph'] || []).map((g) => g.offers).find(Boolean));
                const off = Array.isArray(offers) ? offers[0] : offers;
                if (off && off.price != null) { basePrice = num(off.price); break; }
            }
            if (basePrice != null) break;
        }
    } catch (e) { /* ignore */ }
    if (basePrice == null) {
        const m = document.title.match(/\$\s*([\d,.]+)/);
        if (m) basePrice = num(m[1].replace(/,/g, ''));
    }

    const record = {
        scrapedAt: new Date().toISOString(),
        url: location.href,
        productId,
        name: text((document.querySelector('h1') || {}).innerText) || text(document.title),
        basePrice,
        hasConfigurator: !!(cc && cc.is_ready && cc.steps && Object.keys(cc.steps).length),
        // Which configurator TEMPLATE this door type uses. Types map to different
        // templates with different step sets — e.g. Swing → what-config (id 11),
        // Frameless → metal-frame (id 12). Step codes are only comparable within a template.
        configuratorTemplate: (cc && cc.code) ? { id: cc.id, code: cc.code, name: cc.name } : null,
        harvestMode,
        configurator: null,
        harvestStats: null,
        slabPriceGrid: null, // size -> price (static, no walk needed)
        bom: null,
        bomTotal: null,
        // bomTotal = the priced "YOUR RESULT" total for the DEFAULT configuration
        // (target + autoselect components incl. frame/jamb/kit/caps/pre-cuts with counts).
        // It matches the door total the site shows for those default selections; a
        // different configuration (handle brand, sweep, etc.) yields a different total.
        bomTotal_note: 'YOUR RESULT total for the default configuration (target + autoselect + counts)',
        bomError: null,
        pdp: null, // static PDP content: name/description/technicalInformation/images
    };

    // ---- static PDP content (works for any product, configurator or not) ----
    const cleanTxt = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const descEl = document.querySelector('.block-ltr')
        || [...document.querySelectorAll('p,div')].find((e) => /modern design:|eco-friendly|construction/i.test(e.innerText || '') && (e.innerText || '').length > 200);
    const technicalInformation = [];
    const techTbl = document.querySelector('table.producttable');
    if (techTbl) {
        for (const row of techTbl.rows) {
            const cells = [...row.cells].map((c) => cleanTxt(c.innerText));
            if (cells[0] && cells[1]) technicalInformation.push({ key: cells[0], value: cells[1] });
        }
    }
    const baseName = (u) => u.split('/').pop().replace(/\.(png|jpe?g|webp).*$/i, '');
    const allImgs = [...new Set(
        [...document.querySelectorAll('img')]
            .map((i) => i.src || i.getAttribute('data-src'))
            .filter(Boolean)
            .filter((s) => /\/catalog\/product\//.test(s) && !/logo/i.test(s)),
    )];
    const originalImgs = [...new Map(allImgs.filter((s) => !/\/cache\//.test(s)).map((u) => [baseName(u), u])).values()];
    // DOORS SIZE grid — links to each slab-size SKU page. Present on slab product
    // pages (incl. "Only Slab" which has no configurator), so slab sizes are still
    // discoverable there. Each linked page carries that size's own price.
    const slabSizeLinks = [];
    {
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="door-slab"]')) {
            const size = cleanTxt(a.textContent);
            const url = a.getAttribute('href');
            if (!url || !/^\d+["”]?\s*[xX]\s*\d+/.test(size) || seen.has(size + url)) continue;
            seen.add(size + url);
            slabSizeLinks.push({ size, url });
        }
    }
    record.pdp = {
        name: record.name,
        description: descEl ? cleanTxt(descEl.innerText) : null,
        technicalInformation,
        images: { originals: originalImgs, all: allImgs },
        slabSizeLinks,
    };

    if (!record.hasConfigurator) return record;

    // ---- normalize the static step tree ------------------------------------
    const raw = cc.steps || {};
    const steps = Object.keys(raw).map((pos) => {
        const s = raw[pos];
        const sel = s.select || s._select;
        const dims = (sel && sel.code && Array.isArray(sel.list))
            ? [{ key: sel.key || null, code: sel.code, values: sel.list.map((x) => ({ value: x.value, qty: x.qty })) }]
            : [];
        return {
            position: num(pos),
            id: s.id ?? null,
            code: s.code ?? null,
            name: s.name ?? null,
            order: num(s.order),
            required: !!s.required,
            isActiveFilter: s.is_active_filter === '1',
            filterKeys: s.filter && typeof s.filter === 'object' ? Object.keys(s.filter) : null,
            default: (s.target && typeof s.target === 'object') ? optSummary(s.target) : null,
            // dimension selectors (height / width / …). Empty in the start config for many
            // door types (e.g. Frameless) — populated by the harvest walk below.
            dimensionSelects: dims,
            optionsSource: optionsOf(s).length ? 'static' : null,
            optionsCount: optionsOf(s).length,
            options: optionsOf(s),
        };
    });
    const stepByPos = {};
    for (const st of steps) stepByPos[String(st.position)] = st;

    record.configurator = {
        id: cc.id, code: cc.code, name: cc.name,
        customerGroupId: cc.customer_group_id, requestUrl: cc.requestUrl,
        stepsCount: steps.length, steps,
    };

    // slab price grid (size -> price) — STATIC, no walk needed. This is "prices per
    // height & width": every purchasable slab SKU with its dimensions and catalog price.
    // nominal size as shown on DDL's DOORS SIZE buttons, parsed from the slab name
    // (e.g. "… 18\" X 92 1/2\" X 1 3/4\" SOLID CORE" -> "18\" x 92 1/2\"").
    const parseDisplaySize = (nm) => {
        const m = (nm || '').match(/(\d+(?:\s+\d+\/\d+)?)"\s*[xX]\s*(\d+(?:\s+\d+\/\d+)?)"/);
        return m ? `${m[1]}" x ${m[2]}"` : null;
    };
    const infoRaw = Object.values(raw).find((s) => s.code === 'info_model');
    if (infoRaw && infoRaw.list) {
        const grid = [];
        for (const g of Object.values(infoRaw.list)) {
            if (!g || typeof g !== 'object') continue;
            for (const it of Object.values(g)) {
                grid.push({
                    width: num(it.width), height: num(it.height),
                    rawSize: `${it.width}" x ${it.height}"`,
                    displaySize: parseDisplaySize(it.name), // as shown to customers on DDL
                    price: num(it.catalog_price ?? it.price),
                    sku: it.sku ?? null, article: it.article ?? null,
                    url: it.url_path ? '/' + it.url_path : null,
                    name: it.name ?? null,
                });
            }
        }
        record.slabPriceGrid = grid;
    }

    // Each door TYPE (Swing / Frameless / Pocket / Barn / Bypass / Bi-Fold / …) is a
    // SEPARATE product URL with its own step tree. The config_first step lists them all;
    // surface the current type + the sibling URLs so they can be enqueued/discovered.
    const cfStep = steps.find((s) => s.code === 'config_first' || s.code === 'config');
    record.doorType = cfStep && cfStep.default
        ? { code: cfStep.default.code, name: cfStep.default.name }
        : null;
    record.doorTypeSiblings = cfStep
        ? cfStep.options.map((o) => ({ code: o.code, name: o.name, url: o.targetUrl })).filter((o) => o.url)
        : [];

    // ---- harvest (fill dynamic step option lists) + BOM --------------------
    if (harvestMode !== 'none' || buildBom) {
        try {
            const $ = window.jQuery || window.$;
            if (!$ || !$.param) throw new Error('jQuery.param not available on page');
            const requestUrl = (cc.requestUrl || '/configurator/ajax/').replace(location.origin, '');
            const deadline = Date.now() + walkTimeoutMs;
            const startPos = num(cc.position) || Number(Object.keys(raw)[0]);

            // shared harvest stores: position -> richest option list / dimension selects seen
            const harvested = {};
            const harvestedSelects = {}; // pos -> { [code]: {key, code, values} }
            const bomRows = {};          // pos -> priced BOM rows (only during default walk)
            let bomCapture = false;      // set true only while walking the default path

            // The "YOUR RESULT" table = every step's `target` (if priced) PLUS its
            // `autoselect[]` (auto-added components: SRF jamb, header, casing, extension,
            // caps, pre-cuts, the frame/steel kit, pre-hanging) — each with a `count`.
            const round2 = (n) => Math.round(n * 100) / 100;
            const captureBom = (st, pos) => {
                const rows = [];
                if (st.target && typeof st.target === 'object' && price(st.target) > 0) {
                    rows.push({ kind: 'target', name: st.target.name, sku: st.target.sku ?? null,
                        category: st.target.category ?? null, price: price(st.target), count: num(st.count) || 1 });
                }
                if (Array.isArray(st.autoselect)) {
                    for (const a of st.autoselect) {
                        const d = a && a.data;
                        if (d && price(d) != null && price(d) >= 0) {
                            rows.push({ kind: 'auto', name: d.name, sku: d.sku ?? null,
                                category: d.category ?? null, price: price(d), count: num(a.count) || 1 });
                        }
                    }
                }
                // merge identical (name+price) rows within a step, summing counts
                const merged = [];
                for (const r of rows) {
                    const hit = merged.find((m) => m.name === r.name && m.price === r.price && m.kind === r.kind);
                    if (hit) hit.count += r.count; else merged.push({ ...r });
                }
                if (merged.length) bomRows[pos] = { step: st.code, rows: merged }; // latest state wins
            };

            const recordSteps = (stepsObj) => {
                if (!stepsObj) return 0;
                let gained = 0;
                for (const k of Object.keys(stepsObj)) {
                    const st = stepsObj[k];
                    if (bomCapture) captureBom(st, k);
                    const opts = optionsOf(st);
                    if (opts.length && (!harvested[k] || harvested[k].length < opts.length)) {
                        if (!harvested[k]) gained++;
                        harvested[k] = opts;
                    }
                    // dimension selectors (height/width) show up here too — e.g. Frameless
                    // exposes them only after "number of doors" is chosen.
                    const sel = st.select || st._select;
                    if (sel && sel.code && Array.isArray(sel.list) && sel.list.length) {
                        if (!harvestedSelects[k]) harvestedSelects[k] = {};
                        const prev = harvestedSelects[k][sel.code];
                        if (!prev || prev.values.length < sel.list.length) {
                            harvestedSelects[k][sel.code] = {
                                key: sel.key || null,
                                code: sel.code,
                                values: sel.list.map((x) => ({ value: x.value, qty: x.qty })),
                            };
                        }
                    }
                }
                return gained;
            };
            recordSteps(raw);

            const postAjax = async (payload) => {
                const res = await fetch(requestUrl, {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    },
                    body: $.param(payload),
                    credentials: 'same-origin',
                });
                const txt = await res.text();
                try { return JSON.parse(txt); } catch (e) { return {}; }
            };

            // Walk from the start following `div` (position -> option entity_id to
            // force). Returns { decisions, bom }. Harvests into the shared store.
            // earlyStop: stop after `noGainLimit` consecutive POSTs reveal no new step.
            const walkOnce = async (div, { collectBom = false, earlyStop = false, noGainLimit = 4 } = {}) => {
                let stepsState = JSON.parse(JSON.stringify(cc.steps));
                let position = startPos;
                let isFinish = false;
                const attempts = {};
                const decisions = [];
                const bom = [];
                let noGain = 0;

                for (let i = 0; i < 80 && !isFinish; i++) {
                    if (Date.now() > deadline) break;
                    const step = stepsState[String(position)];
                    if (!step) break;
                    const tries = (attempts[position] = (attempts[position] || 0) + 1);
                    if (tries > 6) break;

                    const sel = step.select || step._select;
                    const items = flattenListRaw(step.list).map((x) => x.it);
                    const selectable = items.filter((it) => idOf(it) && idOf(it) !== '0');
                    if (items.length > 1) {
                        decisions.push({ pos: position, code: step.code, optionIds: selectable.map(idOf) });
                    }

                    const payload = { position, product_id: productId };
                    const line = { position, stepCode: step.code, stepName: step.name };
                    const forceSkip = tries >= 4;

                    if (!forceSkip && sel && sel.code && Array.isArray(sel.list) && sel.list.length) {
                        payload.attribute = { key: sel.key || sel.code, code: sel.code, value: sel.list[0].value };
                        line.chosen = { code: sel.code, value: sel.list[0].value };
                    } else if (!forceSkip && div[position] != null
                        && items.find((it) => idOf(it) === String(div[position]))) {
                        payload.target = items.find((it) => idOf(it) === String(div[position]));
                        line.chosen = optSummary(payload.target);
                    } else if (!forceSkip && step.target && (step.target.entity_id || step.target.sku)) {
                        payload.target = step.target;
                        line.chosen = optSummary(step.target);
                    } else if (!forceSkip && selectable.length) {
                        payload.target = selectable[0];
                        line.chosen = optSummary(selectable[0]);
                    } else {
                        payload.target = 'skip';
                        line.chosen = { skipped: true };
                    }

                    const res = await postAjax(payload);
                    if (res && res.error) break;
                    const gained = recordSteps(res && res.steps);
                    if (res && res.steps) stepsState = res.steps;
                    const nextPos = num(res && res.position);
                    isFinish = !!(res && res.is_finish);
                    if (collectBom && line.chosen && !line.chosen.skipped) bom.push(line);

                    noGain = gained > 0 ? 0 : noGain + 1;
                    if (earlyStop && noGain >= noGainLimit) break;

                    if (nextPos == null) break;
                    if (nextPos === position) {
                        if (payload.target === 'skip' && tries >= 4) break;
                        continue;
                    }
                    position = nextPos;
                }
                return { decisions, bom };
            };

            // 1) default path (captures the priced BOM via target+autoselect)
            bomCapture = buildBom;
            const first = await walkOnce({}, { collectBom: buildBom, earlyStop: false });
            bomCapture = false; // branch walks must not pollute the default BOM

            // 2) optional branch expansion (coverage-driven divergence BFS)
            let walks = 1;
            if (harvestMode === 'branches' || harvestMode === 'full') {
                const full = harvestMode === 'full';
                // Only diverge on STRUCTURAL decision steps (few options: type / swing
                // direction / yes-no / single-double / inside-outside / lockset function).
                // Big product lists (hinges×12, handles×24, locks×5) don't branch the tree
                // — they're captured once on the path — so exploring each is wasted work.
                const branchCap = full ? (opts.branchCap || 8) : 6;
                const processed = new Set(['{}']);
                const queue = [];
                const enqueueFrom = (div, decisions) => {
                    for (const d of decisions) {
                        if (d.optionIds.length > branchCap) continue;
                        for (const oid of d.optionIds) {
                            const ndiv = { ...div, [d.pos]: oid };
                            const key = JSON.stringify(ndiv);
                            if (!processed.has(key)) queue.push({ div: ndiv, key });
                        }
                    }
                };
                enqueueFrom({}, first.decisions);
                while (queue.length && walks < maxBranchWalks && Date.now() < deadline) {
                    const { div, key } = queue.shift();
                    if (processed.has(key)) continue;
                    processed.add(key);
                    const before = Object.keys(harvested).length;
                    // deep walk (no early-stop): alternate branches — wall thickness,
                    // american/AGB handles, LH/RH lockset variants — live deep in the tree.
                    const r = await walkOnce(div, { earlyStop: false });
                    walks++;
                    // 'full' keeps expanding every new decision to chase 100% coverage;
                    // 'branches' only expands when a divergence actually revealed new steps.
                    if (full || Object.keys(harvested).length > before) enqueueFrom(div, r.decisions);
                }
            }

            // 3) merge harvested option lists + dimension selects back into the tree
            let filled = 0;
            for (const posKey of Object.keys(harvested)) {
                const st = stepByPos[posKey];
                if (!st) continue;
                if (harvested[posKey].length > st.options.length) {
                    st.options = harvested[posKey];
                    st.optionsCount = harvested[posKey].length;
                    st.optionsSource = st.optionsSource === 'static' ? 'static' : 'harvested';
                    filled++;
                }
            }
            for (const posKey of Object.keys(harvestedSelects)) {
                const st = stepByPos[posKey];
                if (!st) continue;
                for (const code of Object.keys(harvestedSelects[posKey])) {
                    const hd = harvestedSelects[posKey][code];
                    const existing = st.dimensionSelects.find((d) => d.code === code);
                    if (!existing) st.dimensionSelects.push(hd);
                    else if (existing.values.length < hd.values.length) existing.values = hd.values;
                }
            }
            const stepsWithOptions = steps.filter((s) => s.optionsCount > 0).length;
            record.harvestStats = {
                walks,
                stepsTotal: steps.length,
                stepsWithOptions,
                coveragePct: Math.round((stepsWithOptions / steps.length) * 100),
                stepsFilledByHarvest: filled,
                totalOptions: steps.reduce((a, s) => a + s.optionsCount, 0),
                timedOut: Date.now() >= deadline,
                // step CODES still missing an option list (many are contextual
                // duplicates of already-captured steps on deeply branched types)
                emptyStepCodes: steps.filter((s) => s.optionsCount === 0 && !s.dimensionSelects.length && !s.default)
                    .map((s) => s.code),
            };

            // 4) assemble the priced BOM (target + autoselect + count), like "YOUR RESULT"
            if (buildBom) {
                // The info_model row is just the catalog default placeholder. Drop it
                // whenever any OTHER step already contributes a real slab line (the
                // resolved leaf/leaves) — works across all templates (slab, slab-two,
                // magic/barn slab steps with their own codes, etc.).
                const hasOtherSlab = Object.values(bomRows).some(
                    (b) => b.step !== 'info_model' && b.rows.some((r) => /door slab/i.test(r.name || '')),
                );
                const bom = [];
                for (const pos of Object.keys(bomRows).sort((a, b) => Number(a) - Number(b))) {
                    const { step, rows } = bomRows[pos];
                    if (hasOtherSlab && step === 'info_model') continue;
                    for (const r of rows) {
                        bom.push({
                            position: num(pos), step, kind: r.kind, name: r.name, sku: r.sku,
                            category: r.category, unitPrice: r.price, count: r.count,
                            lineTotal: round2(r.price * r.count),
                        });
                    }
                }
                record.bom = bom;
                record.bomTotal = round2(bom.reduce((a, l) => a + l.lineTotal, 0));
                record.bomPricedLines = bom.length;
            }
        } catch (e) {
            record.bomError = String(e && e.message ? e.message : e);
        }
    }

    return record;
}
