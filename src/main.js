import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { pageExtract } from './pageExtract.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrls = [],
    productIds = [],
    harvestMode = 'path',
    buildBom = true,
    maxBranchWalks = 14,
    branchCap = 8,
    walkTimeoutSecs = 60,
    expandDoorTypes = false,
    maxConcurrency = 8,
    maxRequestRetries = 5,
    proxyConfiguration: proxyInput = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (!proxyConfiguration) {
    log.warning('No proxy configured. Cloudflare will very likely block datacenter/local IPs — use RESIDENTIAL Apify proxy.');
}

// Build the request list. Product URLs are the primary input; product ids are
// resolved through the /configurator/ajax/start/ endpoint (tree only, no BOM walk).
const requests = [];
for (const s of startUrls) {
    const url = typeof s === 'string' ? s : s.url;
    if (url) requests.push({ url, userData: { mode: 'product' } });
}
for (const id of productIds) {
    const pid = String(id).trim();
    if (pid) {
        requests.push({
            url: `https://doordesignlab.com/configurator/ajax/start/?product_id=${encodeURIComponent(pid)}`,
            userData: { mode: 'startEndpoint', productId: pid },
        });
    }
}
if (!requests.length) throw new Error('No input. Provide startUrls (product URLs) and/or productIds.');

// Domains we never need — blocking them cuts page-load time dramatically and
// avoids third-party scripts hanging the load. Same-origin JS (jQuery, Vue,
// widget.js) is always allowed so the configurator can initialize.
const BLOCK_HOSTS = [
    'facebook.net', 'facebook.com', 'google-analytics.com', 'googletagmanager.com',
    'clarity.ms', 'bing.com', 'bat.bing.com', 'pinterest.com', 'pinimg.com',
    'mc.yandex.ru', 'yandex.net', 'reviews.io', 'affirm.com', 'stripe.com',
    'gstatic.com', 'clickcease.com', 'zadarma.com', 'belwood.ru', 'doubleclick.net',
    'google.com/recaptcha', 'googleadservices.com',
];
const BLOCK_TYPES = new Set(['image', 'media', 'font']);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency,
    maxRequestRetries,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 180,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 200 },
    browserPoolOptions: { useFingerprints: true, retireBrowserAfterPageCount: 20 },
    launchContext: { launchOptions: { headless: true } },

    preNavigationHooks: [
        async ({ page }) => {
            await page.route('**/*', (route) => {
                const req = route.request();
                const url = req.url();
                const type = req.resourceType();
                if (BLOCK_TYPES.has(type) || BLOCK_HOSTS.some((h) => url.includes(h))) {
                    return route.abort();
                }
                return route.continue();
            });
        },
    ],

    async requestHandler({ request, page, session, addRequests, log: rlog }) {
        const { mode, productId } = request.userData;
        await page.goto(request.url, { waitUntil: 'domcontentloaded' });

        // --- Cloudflare gate ------------------------------------------------
        await page
            .waitForFunction(() => !/just a moment|attention required/i.test(document.title), { timeout: 45000 })
            .catch(() => {});
        const title = await page.title().catch(() => '');
        if (/just a moment|attention required/i.test(title)) {
            session?.retire();
            throw new Error('Cloudflare challenge not passed — retrying with a fresh session/IP.');
        }

        // --- productId mode: parse the config out of the start fragment ------
        if (mode === 'startEndpoint') {
            const rec = await page.evaluate((pid) => {
                const html = document.documentElement.innerHTML;
                const m = html.match(/configuratorConfig\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/)
                    || html.match(/configuratorConfig\s*=\s*(\{[\s\S]*\})\s*;/);
                let cfg = null;
                try { cfg = m ? JSON.parse(m[1]) : (window.configuratorConfig || null); } catch (e) { cfg = window.configuratorConfig || null; }
                if (!cfg) return { productId: pid, hasConfigurator: false, note: 'config not found in start fragment' };
                window.configuratorConfig = cfg; // let pageExtract read it
                return { __hasCfg: true };
            }, productId);

            if (rec && rec.__hasCfg) {
                const full = await page.evaluate(pageExtract, { harvestMode: 'none', buildBom: false, walkTimeoutMs: 0, maxBranchWalks: 0 });
                full.sourceProductId = productId;
                await Actor.pushData(full);
                rlog.info(`OK id=${productId} steps=${full.configurator?.stepsCount}`);
            } else {
                await Actor.pushData({ productId, hasConfigurator: false, url: request.url, note: rec?.note });
                rlog.warning(`id=${productId}: no configurator config`);
            }
            return;
        }

        // --- product page mode ---------------------------------------------
        // The configurator is injected asynchronously by /configurator/ajax/start/.
        await page
            .waitForFunction(() => window.configuratorConfig && window.configuratorConfig.is_ready, { timeout: 25000 })
            .catch(() => {}); // products without a configurator simply won't have it

        const record = await page.evaluate(pageExtract, {
            harvestMode, buildBom, maxBranchWalks, branchCap, walkTimeoutMs: walkTimeoutSecs * 1000,
        });
        await Actor.pushData(record);

        // Each door TYPE is a separate product URL. Optionally enqueue the siblings
        // (Swing / Frameless / Pocket / Barn / Bypass / Bi-Fold / …) discovered in the
        // config_first step so one input URL yields every door type of the model.
        // Crawlee dedupes by URL, so overlapping sibling lists are processed once.
        if (expandDoorTypes && record.hasConfigurator && record.doorTypeSiblings?.length) {
            const origin = new URL(request.url).origin;
            const siblings = record.doorTypeSiblings.map((s) => ({
                url: new URL(s.url, origin).href,
                userData: { mode: 'product', doorTypeCode: s.code },
            }));
            await addRequests(siblings);
            rlog.info(`  ↳ enqueued ${siblings.length} door-type siblings`);
        }

        if (record.hasConfigurator) {
            const h = record.harvestStats || {};
            rlog.info(`OK [${record.doorType?.code ?? '?'}] ${record.name} — steps=${record.configurator.stepsCount}, harvested=${h.stepsFilledByHarvest ?? 0} (walks=${h.walks ?? 0}, opts=${h.totalOptions ?? 0}), bomTotal=${record.bomTotal ?? 'n/a'}`);
        } else {
            rlog.info(`No configurator: ${record.name || request.url}`);
        }
    },

    failedRequestHandler({ request, log: rlog }, error) {
        rlog.error(`FAILED ${request.url}: ${error.message}`);
        return Actor.pushData({ url: request.url, error: error.message, failed: true });
    },
});

await crawler.run(requests);
await Actor.exit();
