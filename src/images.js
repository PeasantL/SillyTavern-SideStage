/**
 * The image half of the strip (from Character Image Viewer): the viewer and its gallery.
 */
import { debounce, escapeHtml, getSTContext, isActivationKey, isEditableTarget } from './util.js';
import { focusedAvatar, mountInStrip, pruneStrip } from './panel.js';

const extensionName = "CharImgViewer";
const settingsKey = "charImgViewer";
const logPrefix = `[${extensionName}]`;

console.log(logPrefix, "Loading v1.5.0...");

const httpImageRegex = /(https?:\/\/[^\s)"]+?\.(?:png|jpg|jpeg|gif|webp))/gi;
const imgSrcRegex =
  /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+?\.(?:png|jpg|jpeg|gif|webp))["']/gi;

function deepScanForImages(obj, foundSet, visited = new WeakSet()) {
  if (!obj || typeof obj !== "object") {
    if (typeof obj === "string") {
      // matchAll iterates a clone, so the shared regexes keep lastIndex at 0.
      for (const match of obj.matchAll(httpImageRegex)) foundSet.add(match[0]);
      for (const match of obj.matchAll(imgSrcRegex)) foundSet.add(match[1]);
    }
    return;
  }
  if (visited.has(obj)) return;
  visited.add(obj);
  Object.values(obj).forEach((value) =>
    deepScanForImages(value, foundSet, visited),
  );
}

const imageDefaults = Object.freeze({
  changeWithGreeting: true,
});
export let imageSettings = Object.assign({}, imageDefaults);

export function loadImageSettings(ctx) {
  if (!ctx || !ctx.extensionSettings) return;
  ctx.extensionSettings[settingsKey] = Object.assign(
    {},
    imageDefaults,
    ctx.extensionSettings[settingsKey],
  );
  imageSettings = ctx.extensionSettings[settingsKey];
  // The viewer always opens by itself now (it is the only way in to it).
  delete imageSettings.autoOpen;
}

function findGroup(ctx) {
  if (!ctx || !ctx.groupId) return null;
  return (ctx.groups || []).find((g) => String(g.id) === String(ctx.groupId)) ?? null;
}

// Whoever last took a turn, ignoring the user's own messages and system ones.
function getLastSpeakerAvatar(ctx) {
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];

  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i];
    if (!message || message.is_user || message.is_system) continue;
    if (message.original_avatar) return message.original_avatar;

    // Messages written before original_avatar existed only carry a name.
    const byName = (ctx.characters || []).find((c) => c.name === message.name);
    if (byName) return byName.avatar;
  }

  return null;
}

// The member the group loop has just handed the turn to, held from the moment
// they are drafted until their reply lands, so the viewer changes over as the
// turn starts rather than when the response has finished generating.
let draftedAvatar = null;

// A group chat has no characterId, so resolve its members instead.
function getActiveCharacters(ctx) {
  if (!ctx) return [];
  const allCharacters = ctx.characters || [];

  if (ctx.groupId) {
    const members = findGroup(ctx)?.members;
    if (!Array.isArray(members)) return [];

    // Show one member's images rather than the whole group's: a roster pin wins,
    // then whoever is taking the turn right now, then whoever spoke last. All
    // three are checked against the member list, so a pin or a speaker who has
    // since left the group falls through to the group as a whole — as does a
    // chat where nobody has spoken yet.
    const only = [focusedAvatar, draftedAvatar, getLastSpeakerAvatar(ctx)].find(
      (avatar) => avatar && members.includes(avatar),
    );

    return (only ? [only] : members)
      .map((avatar) => allCharacters.find((c) => c.avatar === avatar))
      .filter(Boolean);
  }

  const id = ctx.characterId;
  if (id === undefined || id === null || id === "") return [];
  const char = allCharacters[id];
  return char ? [char] : [];
}

function getActiveLabel(ctx) {
  const active = getActiveCharacters(ctx);
  if (ctx?.groupId && active.length !== 1) return findGroup(ctx)?.name || "Group";
  return active[0]?.name || "";
}

// Identity that survives characterId reshuffles, so we only reset on real changes.
function getContextKey(ctx) {
  if (!ctx) return null;
  if (ctx.groupId) return `group:${ctx.groupId}`;
  const id = ctx.characterId;
  if (id === undefined || id === null || id === "") return null;
  return `char:${(ctx.characters || [])[id]?.avatar ?? id}`;
}

/**
 * Which cast the viewer is showing, as an identity that survives a rescan:
 * one member's avatar when a group resolves to a single speaker, the group
 * itself when it doesn't, and the character in a solo chat.
 */
function getViewerIdentityKey(ctx) {
  const active = getActiveCharacters(ctx);
  if (ctx?.groupId) {
    return active.length === 1
      ? `member:${active[0].avatar}`
      : `group:${ctx.groupId}`;
  }
  return active[0]?.avatar ? `char:${active[0].avatar}` : null;
}

// The image each cast was last left on, so a cast that comes back — a member
// who speaks again, or the one character in a solo chat once their turn lands —
// returns to where you were instead of to the top of its list. URLs rather than
// indices, because a rescan can reorder or resize the list. Session-only, and
// dropped whenever the chat context changes.
const lastViewedByIdentity = new Map();
let viewerIdentityKey = null;

// Where `key` left the viewer, or -1 if nothing is remembered or the image it
// was on is no longer in the list.
function recallViewedIndex(key, images) {
  const url = key ? lastViewedByIdentity.get(key) : null;
  return url ? images.indexOf(url) : -1;
}

// ── Shared image list (populated by scan) ──
let lastScannedImages = [];
let lastScannedCharName = "";

function scanAndGetImages() {
  const ctx = getSTContext();
  const chars = getActiveCharacters(ctx);
  if (chars.length === 0) return null;

  const uniqueImages = new Set();
  chars.forEach((char) => deepScanForImages(char, uniqueImages));

  lastScannedImages = Array.from(uniqueImages);
  lastScannedCharName = getActiveLabel(ctx);
  return { images: lastScannedImages, charName: lastScannedCharName };
}

// Images referenced by the greeting currently on screen. Only chat[0].mes is
// scanned: the message's swipes array holds every alternate greeting, and we
// want the one the user is actually looking at.
function getGreetingImages() {
  const ctx = getSTContext();
  const greeting = Array.isArray(ctx?.chat) ? ctx.chat[0] : null;
  if (!greeting || greeting.is_user || greeting.is_system) return [];
  if (typeof greeting.mes !== "string") return [];

  const found = new Set();
  deepScanForImages(greeting.mes, found);
  return Array.from(found);
}

// Where the greeting's image sits in the master list, or -1 if the greeting
// references none. Mutates `images` when the greeting points at something the
// card scan missed (macro substitution can rewrite a URL at render time).
function getGreetingImageIndex(images) {
  const greetingImages = getGreetingImages();
  if (greetingImages.length === 0) return -1;

  for (const url of greetingImages) {
    const index = images.indexOf(url);
    if (index !== -1) return index;
  }

  images.push(greetingImages[0]);
  return images.length - 1;
}

// ── Singleton viewer state ──
const SINGLE_VIEWER_ID = "civ-single-img-viewer";
const GALLERY_ID = "civ-main-gallery-window";
let viewerState = null; // { $win, $img, index, images, failures }

// Both are sections of the strip (see mountInStrip()). The gallery takes the
// roster's place while it is open — a drill-down you open, pick from and
// dismiss — and closing it brings the roster back.
function spawnGalleryWindow(images, charName) {
  $(`#${GALLERY_ID}`).remove();

  const gridHtml = images
    .map(
      (url, index) =>
        `<img src="${escapeHtml(url)}" class="civ-thumb" data-index="${index}" loading="lazy"
              alt="Image ${index + 1}" title="Open" role="button" tabindex="0" />`,
    )
    .join("");

  const html = `
      <div id="${GALLERY_ID}" class="ss-section civ-gallery">
          <div class="civ-header">
              <span>Gallery: ${escapeHtml(charName)} (${images.length})</span>
              <div class="civ-close-btn gr-header-btn fa-solid fa-circle-xmark fa-fw interactable"
                   role="button" tabindex="0" aria-label="Close gallery" title="Close"></div>
          </div>
          <div class="civ-gallery-body">
              <div class="civ-gallery-grid">${gridHtml}</div>
          </div>
      </div>`;

  const $win = mountInStrip(html);

  const close = () => {
    $win.remove();
    pruneStrip();
  };
  $win
    .find(".civ-close-btn")
    .on("click", close)
    .on("keydown", (e) => {
      if (isActivationKey(e)) {
        e.preventDefault();
        close();
      }
    });

  const open = (el) => spawnSingleImageWindow($(el).data("index"), images);
  const $thumbs = $win.find(".civ-thumb");
  $thumbs.on("click", function () {
    open(this);
  });
  $thumbs.on("keydown", function (e) {
    if (isActivationKey(e)) {
      e.preventDefault();
      open(this);
    }
  });
  $thumbs.on("error", function () {
    $(this).addClass("civ-thumb-error");
  });
  // Catch images that already failed before the handler was attached.
  $thumbs.each(function () {
    if (this.complete && this.naturalWidth === 0)
      $(this).addClass("civ-thumb-error");
  });
}

function closeViewer() {
  $(`#${SINGLE_VIEWER_ID}`).remove();
  viewerState = null;
  pruneStrip();
}

function closeAllWindows() {
  $(`#${SINGLE_VIEWER_ID}, #${GALLERY_ID}`).remove();
  viewerState = null;
  pruneStrip();
}

// Reads the live list off viewerState so a refreshed list is actually used.
function updateImage(newIndex) {
  if (!viewerState) return;
  const list = viewerState.images;
  if (!Array.isArray(list) || list.length === 0) return;

  const index = ((newIndex % list.length) + list.length) % list.length;
  viewerState.index = index;
  viewerState.$win.removeClass("civ-load-error");
  viewerState.$img.attr("src", list[index]);
  // Remembered on show rather than at handoff, so the last thing on screen is
  // what comes back even if the turn ends without another rescan.
  if (viewerIdentityKey) lastViewedByIdentity.set(viewerIdentityKey, list[index]);
}

// ──────────────────────────────────────────────
//  SINGLETON viewer: the strip's image slot, a fixed size (style.css).
//  If it already exists, just switch the image.
// ──────────────────────────────────────────────
function spawnSingleImageWindow(startIndex, allImages) {
  if (!Array.isArray(allImages) || allImages.length === 0) return;

  // ── Singleton: reuse existing section ──
  if (viewerState && $(`#${SINGLE_VIEWER_ID}`).length > 0) {
    viewerState.images = allImages;
    viewerState.failures = 0;
    updateImage(startIndex);
    return;
  }

  // Never leave a stale node behind — the id has to stay unique.
  $(`#${SINGLE_VIEWER_ID}`).remove();

  const currentIndex =
    ((startIndex % allImages.length) + allImages.length) % allImages.length;

  const html = `
      <div id="${SINGLE_VIEWER_ID}" class="ss-section civ-viewer">
          <div class="civ-overlay-container">
              <div class="civ-icon-btn civ-gallery-btn-round" title="Open Gallery" role="button"
                   tabindex="0" aria-label="Open gallery">
                  <i class="fa-solid fa-images"></i>
              </div>
          </div>
          <div class="civ-nav-arrow civ-nav-left" title="Previous" role="button"
               tabindex="0" aria-label="Previous image">
              <i class="fa-solid fa-chevron-left"></i>
          </div>
          <div class="civ-nav-arrow civ-nav-right" title="Next" role="button"
               tabindex="0" aria-label="Next image">
              <i class="fa-solid fa-chevron-right"></i>
          </div>
          <div class="civ-img-wrap">
              <img id="civ-target-img" alt="Character image" />
          </div>
      </div>`;

  const $win = mountInStrip(html);
  const $img = $win.find("#civ-target-img");

  // ── Store singleton state before wiring handlers that read it ──
  viewerState = {
    $win,
    $img,
    index: currentIndex,
    images: allImages,
    failures: 0,
  };

  $img.on("load", () => {
    if (viewerState) viewerState.failures = 0;
  });
  // Skip past dead links instead of showing a broken image.
  $img.on("error", () => {
    if (!viewerState) return;
    viewerState.failures += 1;
    if (
      viewerState.images.length > 1 &&
      viewerState.failures < viewerState.images.length
    ) {
      updateImage(viewerState.index + 1);
    } else {
      viewerState.$win.addClass("civ-load-error");
    }
  });

  $win
    .find(".civ-gallery-btn-round")
    .on("click", openGallery)
    .on("keydown", (e) => {
      if (isActivationKey(e)) {
        e.preventDefault();
        openGallery();
      }
    });

  const step = (delta) => {
    if (viewerState) updateImage(viewerState.index + delta);
  };
  $win.find(".civ-nav-left").on("click", (e) => {
    e.stopPropagation();
    step(-1);
  });
  $win.find(".civ-nav-right").on("click", (e) => {
    e.stopPropagation();
    step(1);
  });
  $win.find(".civ-nav-arrow").on("keydown", function (e) {
    if (!isActivationKey(e)) return;
    e.preventDefault();
    step($(this).hasClass("civ-nav-left") ? -1 : 1);
  });

  updateImage(currentIndex);
}

// Shared by the viewer's round button and the roster footer's: reuse the last
// scan when there is one, otherwise scan now and report what it found.
function openGallery() {
  if (lastScannedImages.length > 0) {
    spawnGalleryWindow(lastScannedImages, lastScannedCharName);
  } else {
    performScan();
  }
}

function performScan() {
  const result = scanAndGetImages();
  if (!result) {
    toastr.warning("No character open.", extensionName);
    return;
  }
  if (result.images.length === 0) {
    toastr.info(`No images found for ${result.charName}.`, extensionName);
    return;
  }
  spawnGalleryWindow(result.images, result.charName);
}

let lastContextKey = null;
// Escape closed the image section: keep it closed until the chat changes,
// rather than bringing it back on the next turn.
let viewerDismissed = false;

/**
 * Points the image section at a fresh scan. It follows the cast: opened when
 * the character on stage has images (and auto-open is on), closed when they
 * have none, so in a group it comes and goes with the turn.
 * @param {{images: string[]}} result Scan result
 * @param {number} index Image to land on
 */
function showImages(result, index) {
  const open = viewerState && $(`#${SINGLE_VIEWER_ID}`).length > 0;
  if (result.images.length === 0) {
    if (open) closeViewer();
  } else if (open) {
    viewerState.images = result.images;
    viewerState.failures = 0;
    updateImage(index);
  } else if (!viewerDismissed) {
    spawnSingleImageWindow(index, result.images);
  }
}

function handleContextChange() {
  const ctx = getSTContext();
  const key = getContextKey(ctx);
  if (key === lastContextKey) {
    // Same character, new or different chat: re-aim at its greeting.
    retargetToGreeting();
    return;
  }
  lastContextKey = key;

  // Character/group changed or the chat closed — tear everything down.
  closeAllWindows();
  lastScannedImages = [];
  lastScannedCharName = "";
  lastViewedByIdentity.clear();
  viewerIdentityKey = null;
  draftedAvatar = null;
  viewerDismissed = false;
  if (key === null) return;

  const result = scanAndGetImages();
  // Set before the window opens, so the image it lands on is what gets
  // remembered for this cast.
  viewerIdentityKey = getViewerIdentityKey(ctx);
  if (result && result.images.length > 0) {
    // Lead with whatever the greeting on screen points at.
    const startIndex = imageSettings.changeWithGreeting
      ? Math.max(0, getGreetingImageIndex(result.images))
      : 0;
    spawnSingleImageWindow(startIndex, result.images);
  }
}

// Follow the greeting: swiping to an alternate one, or opening another chat
// for the same character, changes which image is being talked about.
function retargetToGreeting() {
  if (!imageSettings.changeWithGreeting) return;
  if (!viewerState || $(`#${SINGLE_VIEWER_ID}`).length === 0) return;
  const index = getGreetingImageIndex(viewerState.images);
  if (index >= 0) updateImage(index);
}

/**
 * A member has been drafted to speak. Switching here rather than on the
 * rendered message means the images change as the turn opens, not once the
 * reply is complete.
 * @param {number} chId Index into the character list
 */
function handleMemberDrafted(chId) {
  const avatar = (getSTContext()?.characters || [])[chId]?.avatar;
  if (!avatar || avatar === draftedAvatar) return;
  draftedAvatar = avatar;
  refocusViewer();
}

// The turn is over: hand the viewer back to ordinary last-speaker resolution,
// which lands on this same member when they actually posted, and on the
// previous one when the generation was aborted.
function clearDraftedAvatar() {
  draftedAvatar = null;
}

function handleMessageSwiped(mesId) {
  if (Number(mesId) !== 0) return;
  retargetToGreeting();
}

/**
 * The image source may have changed — a different character is being shown — so
 * the viewer re-aims at whatever the incoming cast was last left on, and at the
 * top of the list for a cast that has not been seen yet.
 */
export function refocusViewer() {
  if (lastContextKey === null) return;

  const ctx = getSTContext();
  const result = scanAndGetImages();
  if (!result) return;

  // Pick up where this cast was left rather than at the top of its list: in a
  // group the turn passes between casts, and in a solo chat the list never
  // changed at all, so a finished turn should not undo browsing either.
  const nextKey = getViewerIdentityKey(ctx);
  const startIndex = Math.max(0, recallViewedIndex(nextKey, result.images));
  viewerIdentityKey = nextKey;

  showImages(result, startIndex);

  if ($(`#${GALLERY_ID}`).length > 0) {
    spawnGalleryWindow(result.images, result.charName);
  }
}

// Card edits and group membership changes alter the image list in place.
function handleContentUpdate() {
  if (lastContextKey === null) return;
  const ctx = getSTContext();
  const result = scanAndGetImages();
  if (!result) return;

  // A membership edit can hand the viewer to a different cast without a turn.
  viewerIdentityKey = getViewerIdentityKey(ctx);

  showImages(result, viewerState ? viewerState.index : 0);

  if ($(`#${GALLERY_ID}`).length > 0) {
    spawnGalleryWindow(result.images, result.charName);
  }
}

// One handler for the lifetime of the page: per-window bindings leaked and
// collided on the shared namespace, which broke Escape and duplicated ids.
$(document).on("keydown.civ", function (e) {
  if (!viewerState) return;
  if ($(`#${SINGLE_VIEWER_ID}`).length === 0) {
    viewerState = null;
    return;
  }
  if (isEditableTarget(e.target)) return;

  if (e.key === "Escape") {
    e.preventDefault();
    viewerDismissed = true;
    closeViewer();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    updateImage(viewerState.index - 1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    updateImage(viewerState.index + 1);
  }
});

export function initImages() {
  const ctx = getSTContext();
  if (!ctx) {
    console.warn(logPrefix, "SillyTavern context unavailable; not starting.");
    return;
  }

  const { eventSource, eventTypes } = ctx;
  if (eventSource && eventTypes) {
    const onContentUpdate = debounce(handleContentUpdate, 250);
    eventSource.on(eventTypes.APP_READY, handleContextChange);
    eventSource.on(eventTypes.CHAT_CHANGED, handleContextChange);
    eventSource.on(eventTypes.CHARACTER_EDITED, onContentUpdate);
    eventSource.on(eventTypes.GROUP_UPDATED, onContentUpdate);
    eventSource.on(eventTypes.MESSAGE_SWIPED, handleMessageSwiped);
    eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, handleMemberDrafted);
    eventSource.on(eventTypes.GENERATION_ENDED, clearDraftedAvatar);
    eventSource.on(eventTypes.GENERATION_STOPPED, clearDraftedAvatar);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, refocusViewer);
    eventSource.on(eventTypes.MESSAGE_DELETED, refocusViewer);
  } else {
    console.warn(logPrefix, "Event source unavailable; auto-open disabled.");
  }

  handleContextChange();
}
