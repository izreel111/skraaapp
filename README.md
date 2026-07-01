# Door Design Lab configurator scraper (Apify)

Fast, mass-runnable scraper for **doordesignlab.com** (Magento) door configurators.

## Why it's fast (the key insight)

The old approach clicked through every configurator step in a browser → ~2 hours per
product. That's unnecessary. On this site **the entire configurator is delivered as one
JSON blob**:

- On page load the site calls `GET /configurator/ajax/start/?product_id=<id>` which injects
  `window.configuratorConfig` — a ~335 KB object containing **all 40+ steps, every option
  (with prices, SKUs, articles, images), the default selections (`target`), and the
  dimension selectors**. The Vue widget then just renders/branches over this locally.
- So per product we do **one page load** and read one variable. Seconds, not hours.

### Door types = separate products with different steps
The door *type* (**Swing, Frameless, Double Swing, Only Slab, Pocket, Double Pocket, Barn,
Bypass, Bi-Fold, Hidden barn**) is chosen in the `config_first` step — but each type is a
**separate product URL with its own, different step tree**. Example (same Optima 4H model):

| Type | URL | Steps |
|---|---|---|
| Swing | `optima-4h-pecan-nutwood.html` | 47 |
| Frameless | `optima-4h-pecan-nutwood-frameless.html` | **78** (adds *Choose number of doors, Flush side with the wall, Select wall thickness, Flush-bolt, Door bottom* …) |

The extractor is **generic** — it walks whatever `configuratorConfig.steps` the page ships,
so it captures each type's steps automatically. Each record carries `doorType` and
`doorTypeSiblings` (the other types' URLs, read from `config_first`). Set
**`expandDoorTypes: true`** to auto-enqueue those siblings, so one input URL per model yields
every door type (deduped by URL). Otherwise supply the type URLs you want directly.

### Dynamic option lists must be harvested
The start config only ships option lists for the **first** steps (slab, config type). The
later steps — swing direction/frame, casing, extensions, **hinges, handles, locksets,
locks**, pre-hanging — arrive **empty** and are filled by the server inside the
`/configurator/ajax/` responses as you reach each step. So to get the full catalog the
actor **harvests**: it replays the site's own `POST /configurator/ajax/` calls (serialized
with the page's `jQuery.param`, byte-for-byte identical to the widget), collects every
option list the responses expose, and merges them back into the tree. Each merged step is
marked `optionsSource: "harvested"` (vs `"static"`).

`harvestMode`:
- **`path`** (default) — one default walk. Fills the recommended build's steps
  (frame/hinges/handles/locksets/locks/…). On the reference product this raised the captured
  option count from 64 → **129** across 13 dynamic steps. ~10–15 requests.
- **`branches`** — `path` plus bounded divergence at common choice steps. Fast, partial.
- **`full`** — coverage-driven exploration of every **structural** branch (type / swing
  direction / yes-no / single-double / inside-outside / lockset function), chasing ~100% step
  coverage. Diverges only on small decision steps (`branchCap`); big converging product lists
  (hinges×12, handles×24) are captured once. Bounded by `maxBranchWalks` + `walkTimeoutSecs`.

  **The alternate branches are NOT duplicates** — verified: on Swing the european lock step
  has 5 SKUs while the american-LH lockset step has **74**, with **0 overlap**. So full
  coverage captures genuinely different products and is worth doing. It is also **expensive**:
  a coverage-driven crawl of the 47-step Swing reached ~45% in ~460 requests / ~3 min before
  its budget ran out — the lockset/handle variants are gated behind
  `direction × brand × function × hand × fire-rated` combos. Give `full` a high
  `maxBranchWalks` (200-500) and `walkTimeoutSecs` to approach completeness; it's best-effort
  and may not hit 100% on the biggest templates within budget.

  **Run `full` once per TEMPLATE, not per product.** Option catalogs (hinges/handles/locks/…)
  are shared across every product of a template (`what-config`, `metal-frame`, …); only the
  slab catalog is per-model. So the cheap way to "cover everything" at scale is: `full` on one
  representative product per template → a complete option dictionary → reuse it, and run cheap
  `path` on every product for its skeleton + slab catalog.

  Each record reports `harvestStats.coveragePct`, `timedOut`, and `emptyStepCodes` so you see
  exactly what was filled.
- **`none`** — tree only, no configurator POSTs (max speed; dynamic steps stay empty).

### The BOM = "YOUR RESULT" (target + autoselect)
With `buildBom` on, the default walk reconstructs the site's **"YOUR RESULT"** table exactly.
Each step contributes: its `target` (if `catalog_price > 0`, quantity = `step.count`) **plus
its `autoselect[]`** — the auto-added components the configurator computes: the **frame**
(Swing: RTA jamb strike/hinges + header + casing + extension; Frameless: the **Steel single
kit invisible**), **hinge caps**, the **pre-cuts** (CIH / lock / sweep), and **pre-hanging**.
Identical lines within a step are merged (counts summed) and the slab is de-duplicated, so the
`bomTotal` matches the door total the site shows for those default selections.

Only the **slab price is static** (`slabPriceGrid`, no walk). Everything else — and it's the
majority of the price (the Frameless steel kit alone is ~$493) — comes from the walk. Change
the default selections (handle brand, sweep, direction, size) and the frame kit / pre-cuts /
counts change accordingly, which is why the total is per-configuration.

### Static PDP content (`pdp`)
Extracted from the page for every product, no walk: exact `name` (h1), `description`,
`technicalInformation` (the `Technical Information` spec table as key/value rows), and `images`
(product gallery — `originals` are the non-cache source images; `all` includes the site's
`/cache/` thumbnails).

## Cloudflare

The site sits behind a **Cloudflare managed challenge** — plain HTTP / `curl` gets `403
Just a moment…`. You need a real browser (this actor uses Playwright + Chromium with
Crawlee fingerprinting) **and residential IPs**. The input defaults to Apify
`RESIDENTIAL` proxy; datacenter IPs will be blocked. Blocked requests auto-retry on a fresh
session/IP (`maxRequestRetries`).

## Input

```jsonc
{
  "startUrls": [                       // primary input: product page URLs
    { "url": "https://doordesignlab.com/optima-4h-pecan-nutwood.html" }
  ],
  "productIds": ["36441"],             // optional: Magento product ids (tree only, no BOM)
  "harvestMode": "path",               // path | branches | none  (dynamic option loading)
  "maxBranchWalks": 14,                // only for harvestMode = "branches"
  "walkTimeoutSecs": 60,               // per-product budget for configurator POSTs
  "expandDoorTypes": false,            // auto-enqueue sibling door-type URLs per model
  "buildBom": true,                    // walk default path for the finished BOM
  "maxConcurrency": 8,
  "maxRequestRetries": 5,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

Give it a list of product URLs (or ids). It does **not** crawl categories — supply the URLs.

## Output (one dataset item per product)

```jsonc
{
  "scrapedAt": "…",
  "url": "https://doordesignlab.com/optima-4h-pecan-nutwood.html",
  "productId": "36441",
  "name": "OPTIMA 4H PECAN NUTWOOD …",
  "basePrice": 409,
  "hasConfigurator": true,             // false for plain products (still recorded)
  "configuratorTemplate": { "id": "12", "code": "metal-frame", "name": "metal-frame" },
  // ^ door types map to DIFFERENT templates with different step sets:
  //   Swing → what-config (id 11), Frameless → metal-frame (id 12), etc.
  //   Step codes are only comparable within the same template.
  "doorType": { "code": "swing", "name": "Swing" },
  "doorTypeSiblings": [ { "code": "invisible", "name": "Frameless", "url": "/optima-4h-pecan-nutwood-frameless.html" }, … ],
  "configurator": {
    "id": "11", "code": "what-config", "stepsCount": 47,
    "steps": [
      {
        "position": 1, "code": "info_model", "name": "…",
        "required": true, "filterKeys": ["slab"],
        "default": { "sku": "…", "article": "…", "name": "…", "price": 255, "targetUrl": "…" },
        "dimensionSelects": [ { "code": "height", "values": [ { "value": 79, "qty": 7000 }, … ] }, { "code": "width", "values": [ … ] } ],
        // ^ HEIGHT / WIDTH selectors. Empty in the start config for some door types
        //   (e.g. Frameless) — filled by the harvest walk, same as `options`.
        "optionsSource": "static",     // "static" (in start config) | "harvested" (loaded via ajax) | null
        "optionsCount": 54,
        "options": [ { "id": "…", "name": "…", "sku": "…", "article": "…", "price": 509, "image": "…", "targetUrl": "…", "group": "slab" }, … ]
      }
      // … all steps: config type, slab, swing direction, casing, extensions,
      //   hinges, handles, locksets, locks, pre-hanging, …
    ]
  },
  "harvestStats": { "walks": 1, "stepsTotal": 47, "stepsWithOptions": 15, "coveragePct": 32, "stepsFilledByHarvest": 13, "totalOptions": 129, "timedOut": false, "emptyStepCodes": ["…"] },

  "pdp": {                             // static PDP content (any product, no walk)
    "description": "Modern design: Optima 4H combines …",
    "technicalInformation": [ { "key": "Type of Configuration", "value": "Frameless doors" }, { "key": "Jamb Width", "value": "4 9/16''" }, … ],
    "images": { "originals": ["…/o/p/optima-4h-pn_invisible_frame.png"], "all": ["…(incl. /cache/ thumbnails)"] },
    "slabSizeLinks": [ { "size": "18\" X 84\"", "url": "https://…/door-slab-…-18-x-84-….html" }, … ]  // DOORS SIZE grid (works on slab pages w/o configurator)
  },
  "slabPriceGrid": [                   // prices per height & width — STATIC, no walk (from configuratorConfig)
    { "width": 17, "height": 92, "rawSize": "17\" x 92\"", "displaySize": "18\" x 92 1/2\"", "price": 509, "sku": "…", "article": "…", "url": "/door-slab-….html", "name": "DOOR SLAB … 18\" X 92 1/2\" …" }, …  // 54 SKUs
  ],
  "bom": [                            // the priced "YOUR RESULT" for the default config
    { "position": 5,  "step": "slab",                       "kind": "target", "name": "DOOR SLAB … 18\" X 80\"", "unitPrice": 409, "count": 1, "lineTotal": 409 },
    { "position": 73, "step": "wall-outside-not-reverse-srf","kind": "auto",   "name": "STEEL SINGLE KIT INVISIBLE TYPE 3/54 LHI/RHO 18\" X 80\" MORELLI", "unitPrice": 492.8, "count": 1, "lineTotal": 492.8 },
    { "position": 32, "step": "metal-frame-hinges",         "kind": "auto",   "name": "PRE-CUT FOR CIH (Invisible Metal jamb)", "unitPrice": 32, "count": 1, "lineTotal": 32 },
    { "position": 65, "step": "invisbile-lock",             "kind": "auto",   "name": "PRE-CUT FOR MORELLI MAGNETIC LOCK", "unitPrice": 32, "count": 1, "lineTotal": 32 }
    // … hinges, caps, handle, lock, sweep + its pre-cut, pre-hanging — every priced line
  ],
  "bomTotal": 1243.6,
  "bom": [                             // present when buildBom = true
    { "position": 1,  "stepCode": "info_model",   "stepName": "Door Slab", "chosen": { "name": "DOOR SLAB …", "sku": "…", "price": 255 } },
    { "position": 3,  "stepCode": "slab",          "chosen": { "code": "height", "value": 79 } },
    { "position": 14, "stepCode": "byd_ss-hinges", "chosen": { "name": "OTLAV 3D-ADJUSTABLE CONCEALED HINGE", "price": 33.6 } },
    …
  ],
  "bomTotal": 447.6,
  "bomError": null                     // set instead of bom if the walk failed
}
```

`hasConfigurator: false` is emitted for products that don't expose a configurator, so you
can tell "full configurator vs not" directly from the dataset.

## Run

**On Apify:** push this folder (`apify push`) or paste the files into a new Actor, set the
input, Start. Requires the Playwright/Chromium base image (see `Dockerfile`) and a
residential proxy.

**Locally** (for development; needs residential proxy env or you'll be Cloudflare-blocked):
```bash
npm install
npx playwright install chromium
# put your input in storage/key_value_stores/default/INPUT.json
APIFY_TOKEN=… node src/main.js
```

## Notes / tuning
- Heavy assets (images, fonts, media) and third-party trackers are blocked at the network
  layer to speed up load — same-origin JS (jQuery/Vue/`widget.js`) is always allowed so the
  configurator initializes.
- The default walk = "fully loaded" base door (picks Yes on casing/extensions/hinges, first
  option elsewhere), matching the site's own recommended build. Set `harvestMode: "none"` +
  `buildBom: false` for pure tree extraction (one request per product, maximum speed).
- `reference-frameless.sample.json` is a real `harvestMode: "path"` extraction of the
  Frameless door type (78 steps, 117 options; harvested dimension selectors HEIGHT/WIDTH and
  steps like *Choose number of doors* and *Flush side with the wall*) so you can see the exact
  output shape — including the door-type-specific steps — without running the actor.
