/**
 * The tablet layout and the home-screen web app's status bar.
 */

// Any iPad, in either orientation: a touch screen at least 744px both ways (an
// iPad mini is 744 wide in portrait), up to 1420px wide. Phones fail the
// height or the width, and a mouse-only desktop window fails the pointer, so
// neither is touched however narrow it gets. any-pointer rather than pointer:
// with a Magic Keyboard or trackpad attached, an iPad's primary pointer turns
// fine and the whole layout would drop back to desktop.
const TABLET_QUERY = '(any-pointer: coarse) and (min-width: 744px) and (min-height: 744px) and (max-width: 1420px)';

// Core's touch layout lives in one @media block in mobile-styles.css that
// stops at 1000px, so an iPad gets it in portrait and loses it in landscape.
// A copy of that block under the tablet query is added at page load, from
// core's live rules — so it keeps up with SillyTavern updates, where a
// hand-made copy (what user.css used to carry) goes stale: it had already
// missed the background-folder and multi-select rules added since it was
// taken.
//
// The copy goes at the very end of the sheet, which is where user.css's copy
// sat in the cascade (after all of core's CSS). Not straight after the
// original: the sheet ends with an iOS-only block, @supports
// (-webkit-touch-callout: none), whose `.drawer-content { top: 0; margin-top:
// 36px }` then wins, and on top of user.css's PWA `top` it opened every drawer
// 36px below the chat's top. That block never applies in desktop or emulated
// WebKit, which is why only the real iPad showed it.
//
// Inserted rather than adding the query to the original's media list: Safari
// did not apply a media list edited in place, and insertRule always restyles.
// Rule by rule into an empty block, so one rule an engine won't re-parse from
// its own serialisation costs that rule, not the whole layout. Found by its
// width rather than its exact text, which engines serialise differently; the
// landscape-only block is skipped by its orientation.
export function stretchMobileLayout() {
    const sheet = [...document.styleSheets].find(s => s.href?.endsWith('/css/mobile-styles.css'));
    const rules = sheet ? [...sheet.cssRules] : [];
    const source = rules.find(rule => rule instanceof CSSMediaRule
        && /max-width:\s*1000px/.test(rule.media.mediaText)
        && !/orientation/.test(rule.media.mediaText));
    if (!source) {
        console.warn('[SideStage] Core touch layout not found; tablet landscape keeps the desktop layout.');
        return;
    }
    const copy = sheet.cssRules[sheet.insertRule(`@media screen and ${TABLET_QUERY} {}`, sheet.cssRules.length)];
    const skipped = [];
    for (const rule of source.cssRules) {
        try {
            copy.insertRule(rule.cssText, copy.cssRules.length);
        } catch {
            skipped.push(rule.cssText.split('{')[0].trim());
        }
    }
    if (skipped.length) {
        console.warn('[SideStage] Tablet layout skipped rules this browser would not re-parse:', skipped);
    }
}

// body.ss-tablet gates the column reserve in style.css. Followed live, so
// plugging in a mouse or a window change re-decides it.
export function watchTablet() {
    const tablet = window.matchMedia(TABLET_QUERY);
    const apply = () => document.body.classList.toggle('ss-tablet', tablet.matches);
    tablet.addEventListener('change', apply);
    apply();
}

// The status bar of SillyTavern as a home-screen web app: iPadOS paints it
// from <meta name="theme-color">, which SillyTavern sets to the theme's Blur
// Tint on every theme load (applyThemeColor('blurTint') in power-user.js), so
// it came out in the tint rather than black. Held at black here, only in the
// web app (a browser tab keeps SillyTavern's own colour). The meta's first
// value and the bar's style (`black`) are in index.html, read before any
// script runs, so those stay with whoever serves SillyTavern.
const STATUS_BAR_COLOR = '#000000';

export function pinStatusBar() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!standalone || !meta) {
        return;
    }
    const pin = () => {
        if (meta.getAttribute('content') !== STATUS_BAR_COLOR) {
            meta.setAttribute('content', STATUS_BAR_COLOR);
        }
    };
    new MutationObserver(pin).observe(meta, { attributes: true, attributeFilter: ['content'] });
    pin();
}
