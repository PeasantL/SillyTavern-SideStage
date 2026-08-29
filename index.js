jQuery(async function () {
  const extensionName = "CharImgViewer";
  const settingsKey = "charImgViewer";
  const logPrefix = `[${extensionName}]`;

  console.log(logPrefix, "Loading v1.4.0...");

  // --- 1. UTILITIES ---
  const httpImageRegex = /(https?:\/\/[^\s)"]+?\.(?:png|jpg|jpeg|gif|webp))/gi;
  const imgSrcRegex =
    /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+?\.(?:png|jpg|jpeg|gif|webp))["']/gi;

  const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  // Card data is untrusted: anything interpolated into markup goes through this.
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function getSTContext() {
    if (typeof SillyTavern === "undefined" || !SillyTavern.getContext)
      return null;
    return SillyTavern.getContext();
  }

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      el.isContentEditable === true
    );
  }

  function isActivationKey(e) {
    return e.key === "Enter" || e.key === " " || e.key === "Spacebar";
  }

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

  function bringToFront($win) {
    $(".civ-window-standard, .civ-window-frameless").css("z-index", 500);
    $win.css("z-index", 501);
  }

  // The viewer's home: flush with the right edge, 24px up from the bottom.
  // Recomputed from the current size so it still lands correctly after a
  // resize or an orientation change.
  function getSpawnPosition(width, height) {
    return {
      top: Math.max(0, window.innerHeight - height - 24),
      left: Math.max(0, window.innerWidth - width),
    };
  }

  // Where a window is *meant* to sit, so a viewport change can be re-applied from
  // the intent rather than from wherever the element currently happens to be.
  const ANCHOR_KEY = "civAnchor";
  const FOLLOW_SPAWN_KEY = "civFollowSpawn";

  // Clamps an intended position to the viewport and writes it. Pure function of
  // (intent, viewport size): running it repeatedly always lands in the same spot.
  function applyPosition($win, top, left) {
    const maxTop = Math.max(0, window.innerHeight - $win.outerHeight());
    const maxLeft = Math.max(0, window.innerWidth - $win.outerWidth());
    $win.css({
      top: `${Math.max(0, Math.min(top, maxTop))}px`,
      left: `${Math.max(0, Math.min(left, maxLeft))}px`,
      right: "auto",
    });
  }

  // Records the layout position. Deliberately reads css(), not
  // getBoundingClientRect(): on iOS the rect of a fixed element is reported
  // against the visual viewport, which drifts while the browser toolbar animates
  // or the app is being switched back to.
  function rememberAnchor($win) {
    $win.data(ANCHOR_KEY, {
      top: parseFloat($win.css("top")) || 0,
      left: parseFloat($win.css("left")) || 0,
    });
  }

  // Send the viewer home and keep it anchored there through viewport changes.
  function anchorViewerToSpawn($win) {
    const { top, left } = getSpawnPosition($win.outerWidth(), $win.outerHeight());
    $win.data(FOLLOW_SPAWN_KEY, true);
    $win.data(ANCHOR_KEY, { top, left });
    applyPosition($win, top, left);
  }

  function resetViewerPosition() {
    if (!viewerState) return;
    anchorViewerToSpawn(viewerState.$win);
  }

  // --- 2. SETTINGS ---
  const defaultSettings = Object.freeze({ autoOpen: true });
  let settings = Object.assign({}, defaultSettings);

  function loadSettings(ctx) {
    if (!ctx || !ctx.extensionSettings) return;
    ctx.extensionSettings[settingsKey] = Object.assign(
      {},
      defaultSettings,
      ctx.extensionSettings[settingsKey],
    );
    settings = ctx.extensionSettings[settingsKey];
  }

  function addSettingsUi() {
    const $container = $("#extensions_settings2");
    if ($container.length === 0) return;

    const html = `
        <div class="civ-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Character Image Viewer</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label" for="civ-auto-open" title="Opens the floating viewer whenever a character or group with images is selected.">
                        <input id="civ-auto-open" type="checkbox">
                        <span>Open the viewer automatically on character select</span>
                    </label>
                    <small class="civ-settings-note">
                        Turning this off leaves no way to open the viewer, since the gallery is reached from it.
                    </small>
                </div>
            </div>
        </div>`;

    $container.append(html);
    $("#civ-auto-open")
      .prop("checked", !!settings.autoOpen)
      .on("change", function () {
        settings.autoOpen = !!$(this).prop("checked");
        getSTContext()?.saveSettingsDebounced?.();
      });
  }

  // --- 3. ACTIVE CHARACTER RESOLUTION ---
  function findGroup(ctx) {
    if (!ctx || !ctx.groupId) return null;
    return (ctx.groups || []).find((g) => String(g.id) === String(ctx.groupId)) ?? null;
  }

  // A group chat has no characterId, so resolve its members instead.
  function getActiveCharacters(ctx) {
    if (!ctx) return [];
    const characters = ctx.characters || [];

    if (ctx.groupId) {
      const members = findGroup(ctx)?.members;
      if (!Array.isArray(members)) return [];
      return members
        .map((avatar) => characters.find((c) => c.avatar === avatar))
        .filter(Boolean);
    }

    const id = ctx.characterId;
    if (id === undefined || id === null || id === "") return [];
    const char = characters[id];
    return char ? [char] : [];
  }

  function getActiveLabel(ctx) {
    if (ctx?.groupId) return findGroup(ctx)?.name || "Group";
    return getActiveCharacters(ctx)[0]?.name || "";
  }

  // Identity that survives characterId reshuffles, so we only reset on real changes.
  function getContextKey(ctx) {
    if (!ctx) return null;
    if (ctx.groupId) return `group:${ctx.groupId}`;
    const id = ctx.characterId;
    if (id === undefined || id === null || id === "") return null;
    return `char:${(ctx.characters || [])[id]?.avatar ?? id}`;
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

  // --- 4. DISPLAY ---
  function spawnGalleryWindow(images, charName, geometry) {
    $(`#${GALLERY_ID}`).remove();

    const gridHtml = images
      .map(
        (url, index) =>
          `<img src="${escapeHtml(url)}" class="civ-thumb" data-index="${index}" loading="lazy"
                alt="Image ${index + 1}" title="Open" role="button" tabindex="0" />`,
      )
      .join("");

    const style =
      geometry ||
      "top: 5vh; right: 0; width: 20vw; height: 45vh;";

    const html = `
        <div id="${GALLERY_ID}" class="civ-window-standard" style="${style}">
            <div class="civ-header">
                <span>Gallery: ${escapeHtml(charName)} (${images.length})</span>
                <span class="civ-close-btn" role="button" tabindex="0" aria-label="Close gallery"
                      title="Close" style="cursor:pointer; color:#ff6b6b;">✖</span>
            </div>
            <div class="civ-gallery-body">
                <div class="civ-gallery-grid">${gridHtml}</div>
            </div>
        </div>`;

    $("body").append(html);
    const $win = $(`#${GALLERY_ID}`);
    bringToFront($win);

    if ($.fn.draggable)
      $win.draggable({
        handle: ".civ-header",
        containment: "window",
        stop: function () {
          rememberAnchor($(this));
        },
      });
    if ($.fn.resizable) $win.resizable();

    const close = () => $win.remove();
    $win
      .find(".civ-close-btn")
      .on("click", close)
      .on("keydown", (e) => {
        if (isActivationKey(e)) {
          e.preventDefault();
          close();
        }
      });
    $win.on("mousedown", function () {
      bringToFront($(this));
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
  }

  function closeAllWindows() {
    $(".civ-window-standard, .civ-window-frameless").remove();
    viewerState = null;
  }

  // Re-shape the window to the incoming image. Keeping the old frame would
  // letterbox a portrait image inside a landscape window, since the <img> is
  // object-fit: contain.
  function fitViewerToRatio(ratio) {
    if (!viewerState || !(ratio > 0)) return;
    const $win = viewerState.$win;

    const currentW = $win.outerWidth();
    const currentH = $win.outerHeight();
    if (!currentW || !currentH) return;
    // Nothing to do for images that are already the same shape.
    if (Math.abs(currentW / currentH - ratio) < 0.01) return;

    // Keep the width the user settled on and derive the height from the new
    // ratio, capped so a tall image cannot run off the screen.
    let width = Math.min(currentW, window.innerWidth * 0.9);
    let height = width / ratio;
    const maxH = window.innerHeight * 0.9;
    if (height > maxH) {
      height = maxH;
      width = height * ratio;
    }

    $win.css({ width: `${width}px`, height: `${height}px` });

    if ($win.data(FOLLOW_SPAWN_KEY)) {
      anchorViewerToSpawn($win);
      return;
    }

    // Grow from the bottom-right corner so a window the user placed by hand
    // stays visually put instead of spilling down and to the right.
    const top = (parseFloat($win.css("top")) || 0) + currentH - height;
    const left = (parseFloat($win.css("left")) || 0) + currentW - width;
    $win.data(ANCHOR_KEY, { top, left });
    applyPosition($win, top, left);
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

    const probe = new Image();
    probe.onload = () => {
      // The user may have navigated on while this was loading.
      if (!viewerState || viewerState.index !== index) return;
      const ratio = probe.naturalWidth / probe.naturalHeight;
      if (!(ratio > 0)) return;
      if (viewerState.$win.data("ui-resizable"))
        viewerState.$win.resizable("option", "aspectRatio", ratio);
      fitViewerToRatio(ratio);
    };
    probe.onerror = () => {};
    probe.src = list[index];
  }

  // ──────────────────────────────────────────────
  //  SINGLETON viewer: 20vw wide | bottom-right | 24px from bottom | aspect-ratio locked
  //  If the window already exists, just switch the image.
  // ──────────────────────────────────────────────
  function spawnSingleImageWindow(startIndex, allImages) {
    if (!Array.isArray(allImages) || allImages.length === 0) return;

    // ── Singleton: reuse existing window ──
    if (viewerState && $(`#${SINGLE_VIEWER_ID}`).length > 0) {
      viewerState.images = allImages;
      viewerState.failures = 0;
      updateImage(startIndex);
      bringToFront(viewerState.$win);
      return;
    }

    // Never leave a stale node behind — the id has to stay unique.
    $(`#${SINGLE_VIEWER_ID}`).remove();

    const currentIndex =
      ((startIndex % allImages.length) + allImages.length) % allImages.length;
    const spawnKey = lastContextKey;

    // Pre-load the image to read its natural dimensions
    const preloader = new Image();
    preloader.src = allImages[currentIndex];

    const buildWindow = () => {
      // The character may have changed while the preloader was in flight.
      if (spawnKey !== lastContextKey) return;

      const natW = preloader.naturalWidth || 400;
      const natH = preloader.naturalHeight || 300;
      const aspectRatio = natW / natH;

      // ── Position & Size ──────────────────────────
      // Preferred width 20vw, capped so neither dimension can leave the viewport.
      const maxH = window.innerHeight * 0.5;
      const maxW = window.innerWidth * 0.9;
      let winW = Math.min(window.innerWidth * 0.2, maxW);
      let winH = winW / aspectRatio;

      if (winH > maxH) {
        winH = maxH;
        winW = winH * aspectRatio;
      }
      if (winW > maxW) {
        winW = maxW;
        winH = winW / aspectRatio;
      }

      const { top, left } = getSpawnPosition(winW, winH);

      const html = `
            <div id="${SINGLE_VIEWER_ID}" class="civ-window-frameless"
                 style="top: ${top}px; left: ${left}px; width: ${winW}px; height: ${winH}px;">
                <div class="civ-overlay-container">
                    <div class="civ-icon-btn civ-drag-handle" title="Move">
                        <i class="fa-solid fa-grip"></i>
                    </div>
                    <div class="civ-icon-btn civ-reset-pos-btn" title="Reset Position" role="button"
                         tabindex="0" aria-label="Reset position">
                        <i class="fa-solid fa-arrows-to-dot"></i>
                    </div>
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
                    <img id="civ-target-img" alt="Character image"
                         src="${escapeHtml(allImages[currentIndex])}" />
                </div>
            </div>`;

      $("body").append(html);
      const $win = $(`#${SINGLE_VIEWER_ID}`);
      const $img = $win.find("#civ-target-img");

      // ── Store singleton state before wiring handlers that read it ──
      viewerState = {
        $win,
        $img,
        index: currentIndex,
        images: allImages,
        failures: 0,
      };
      $win.data(FOLLOW_SPAWN_KEY, true);
      $win.data(ANCHOR_KEY, { top, left });
      bringToFront($win);

      // Draggable & Resizable (locked to aspect ratio)
      if ($.fn.draggable)
        $win.draggable({
          handle: ".civ-drag-handle",
          containment: "window",
          stop: function () {
            $(this).data(FOLLOW_SPAWN_KEY, false);
            rememberAnchor($(this));
          },
        });
      if ($.fn.resizable)
        $win.resizable({
          handles: "se",
          aspectRatio: aspectRatio,
        });

      // Skip past dead links instead of showing a broken image.
      $img.on("load", () => {
        if (viewerState) viewerState.failures = 0;
      });
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

      // ── Gallery button (replaces close) ──
      const openGallery = () => {
        if (lastScannedImages.length > 0) {
          spawnGalleryWindow(lastScannedImages, lastScannedCharName);
        } else {
          performScan();
        }
      };
      $win
        .find(".civ-gallery-btn-round")
        .on("click", openGallery)
        .on("keydown", (e) => {
          if (isActivationKey(e)) {
            e.preventDefault();
            openGallery();
          }
        });

      $win
        .find(".civ-reset-pos-btn")
        .on("click", (e) => {
          e.stopPropagation();
          resetViewerPosition();
        })
        .on("keydown", (e) => {
          if (isActivationKey(e)) {
            e.preventDefault();
            resetViewerPosition();
          }
        });
      $win.on("mousedown", function () {
        bringToFront($(this));
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
    };

    // Wait for preloader, or build immediately if already cached
    if (preloader.complete && preloader.naturalWidth > 0) {
      buildWindow();
    } else {
      preloader.onload = buildWindow;
      preloader.onerror = buildWindow;
    }
  }

  // --- 5. SCAN LOGIC ---
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

  // --- 6. EVENT WIRING ---
  let lastContextKey = null;

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
    if (key === null) return;

    const result = scanAndGetImages();
    if (settings.autoOpen && result && result.images.length > 0) {
      // Lead with whatever the greeting on screen points at.
      const startIndex = Math.max(0, getGreetingImageIndex(result.images));
      spawnSingleImageWindow(startIndex, result.images);
    }
  }

  // Follow the greeting: swiping to an alternate one, or opening another chat
  // for the same character, changes which image is being talked about.
  function retargetToGreeting() {
    if (!viewerState || $(`#${SINGLE_VIEWER_ID}`).length === 0) return;
    const index = getGreetingImageIndex(viewerState.images);
    if (index >= 0) updateImage(index);
  }

  function handleMessageSwiped(mesId) {
    if (Number(mesId) !== 0) return;
    retargetToGreeting();
  }

  // Card edits and group membership changes alter the image list in place.
  function handleContentUpdate() {
    if (lastContextKey === null) return;
    const result = scanAndGetImages();
    if (!result) return;

    if (viewerState && $(`#${SINGLE_VIEWER_ID}`).length > 0) {
      if (result.images.length === 0) {
        closeViewer();
      } else {
        viewerState.images = result.images;
        viewerState.failures = 0;
        updateImage(viewerState.index);
      }
    }

    const $gallery = $(`#${GALLERY_ID}`);
    if ($gallery.length > 0) {
      const geometry = ["top", "left", "width", "height"]
        .map((prop) => `${prop}: ${$gallery.css(prop)};`)
        .join(" ");
      spawnGalleryWindow(result.images, result.charName, geometry);
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
      closeViewer();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      updateImage(viewerState.index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      updateImage(viewerState.index + 1);
    }
  });

  $(window).on(
    "resize.civ",
    debounce(() => {
      // A backgrounded tab reports garbage viewport sizes; acting on them is
      // what displaced the viewer on every app switch.
      if (document.hidden) return;
      if (!window.innerWidth || !window.innerHeight) return;

      $(".civ-window-standard, .civ-window-frameless").each(function () {
        const $win = $(this);
        if ($win.data(FOLLOW_SPAWN_KEY)) {
          anchorViewerToSpawn($win);
          return;
        }
        // No anchor means the window still sits where its CSS put it, which is
        // already viewport-relative and needs no correction.
        const anchor = $win.data(ANCHOR_KEY);
        if (anchor) applyPosition($win, anchor.top, anchor.left);
      });
    }, 150),
  );

  (function init() {
    const ctx = getSTContext();
    if (!ctx) {
      console.warn(logPrefix, "SillyTavern context unavailable; not starting.");
      return;
    }

    loadSettings(ctx);
    addSettingsUi();

    const { eventSource, eventTypes } = ctx;
    if (eventSource && eventTypes) {
      const onContentUpdate = debounce(handleContentUpdate, 250);
      eventSource.on(eventTypes.APP_READY, handleContextChange);
      eventSource.on(eventTypes.CHAT_CHANGED, handleContextChange);
      eventSource.on(eventTypes.CHARACTER_EDITED, onContentUpdate);
      eventSource.on(eventTypes.GROUP_UPDATED, onContentUpdate);
      eventSource.on(eventTypes.MESSAGE_SWIPED, handleMessageSwiped);
    } else {
      console.warn(logPrefix, "Event source unavailable; auto-open disabled.");
    }

    handleContextChange();
  })();
});
