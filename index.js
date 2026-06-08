jQuery(async function () {
  const extensionName = "CharImgViewer";
  const logPrefix = `[${extensionName}]`;

  console.log(logPrefix, "Starting V23 (Back to stability - Active Loop)...");

  // --- 1. UTILITIES ---
  const httpImageRegex = /(https?:\/\/[^\s)"]+?\.(?:png|jpg|jpeg|gif|webp))/gi;
  const imgSrcRegex =
    /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+?\.(?:png|jpg|jpeg|gif|webp))["']/gi;

  function getSTContext() {
    if (typeof SillyTavern === "undefined" || !SillyTavern.getContext)
      return null;
    return SillyTavern.getContext();
  }

  function deepScanForImages(obj, foundSet, visited = new WeakSet()) {
    if (!obj || typeof obj !== "object") {
      if (typeof obj === "string") {
        let match;
        while ((match = httpImageRegex.exec(obj)) !== null) {
          foundSet.add(match[0]);
        }
        httpImageRegex.lastIndex = 0;
        while ((match = imgSrcRegex.exec(obj)) !== null) {
          foundSet.add(match[1]);
        }
        imgSrcRegex.lastIndex = 0;
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

  // ── Shared image list (populated by scan) ──
  let lastScannedImages = [];
  let lastScannedCharName = "";

  function scanAndGetImages() {
    const ctx = getSTContext();
    if (!ctx) return null;
    const id = ctx.characterId;
    if (id === undefined || id === null) return null;
    const char = ctx.characters[id];
    if (!char) return null;

    let uniqueImages = new Set();
    deepScanForImages(char, uniqueImages);
    if (char.avatar && char.avatar.match(httpImageRegex))
      uniqueImages.add(char.avatar);
    const images = Array.from(uniqueImages);
    lastScannedImages = images;
    lastScannedCharName = char.name;
    return { images, charName: char.name };
  }

  // ── Singleton viewer state ──
  const SINGLE_VIEWER_ID = "civ-single-img-viewer";
  let viewerState = null; // { $win, $img, currentIndex, allImages, updateImage }

  // --- 2. DISPLAY ---
  function spawnGalleryWindow(images, charName) {
    const winId = "civ-main-gallery-window";
    $(`#${winId}`).remove();

    let gridHtml = `<div class="civ-gallery-grid">`;
    images.forEach((url, index) => {
      gridHtml += `<img src="${url}" class="civ-thumb" data-index="${index}" title="Open" />`;
    });
    gridHtml += `</div>`;

    const html = `
        <div id="${winId}" class="civ-window-standard" style="top: 5vh; right: 0; width: 20vw; height: 45vh;">
            <div class="civ-header">
                <span>Gallery: ${charName} (${images.length})</span>
                <span class="civ-close-btn" style="cursor:pointer; color:#ff6b6b;">✖</span>
            </div>
            <div style="flex-grow: 1; overflow-y: auto; background: rgba(0,0,0,0.2);">
                ${gridHtml}
            </div>
        </div>`;

    $("body").append(html);
    const $win = $(`#${winId}`);
    bringToFront($win);

    if ($.fn.draggable)
      $win.draggable({ handle: ".civ-header", containment: "window" });
    if ($.fn.resizable) $win.resizable();

    $win.find(".civ-close-btn").on("click", () => $win.remove());
    $win.on("mousedown", function () {
      bringToFront($(this));
    });

    $win.find(".civ-thumb").on("click", function () {
      spawnSingleImageWindow($(this).data("index"), images);
    });
  }

  // ──────────────────────────────────────────────
  //  SINGLETON viewer: 20vw wide | bottom-right | 22px from bottom | aspect-ratio locked | Suited for IPAD-PRO
  //  If the window already exists, just switch the image.
  // ──────────────────────────────────────────────
  function spawnSingleImageWindow(startIndex, allImages) {
    // ── Singleton: reuse existing window ──
    if (viewerState && $(`#${SINGLE_VIEWER_ID}`).length > 0) {
      viewerState.allImages = allImages;
      viewerState.updateImage(startIndex);
      bringToFront($(`#${SINGLE_VIEWER_ID}`));
      return;
    }

    const winId = SINGLE_VIEWER_ID;
    let currentIndex = startIndex;

    // Pre-load the image to read its natural dimensions
    const preloader = new Image();
    preloader.src = allImages[currentIndex];

    const buildWindow = () => {
      const natW = preloader.naturalWidth || 400;
      const natH = preloader.naturalHeight || 300;
      const aspectRatio = natW / natH;

      // ── Position & Size ──────────────────────────
      // Fixed width: 20vw
      const winW = window.innerWidth * 0.2;
      // Height follows the image's aspect ratio
      const winH = winW / aspectRatio;

      // Bottom-right corner, 23px from bottom to be flush with shed bottom of Ipad, flush with right edge
      const top = window.innerHeight - winH - 23;
      const left = window.innerWidth - winW;

      const html = `
            <div id="${winId}" class="civ-window-frameless"
                 style="top: ${top}px; left: ${left}px; width: ${winW}px; height: ${winH}px;">
                <div class="civ-overlay-container">
                    <div class="civ-icon-btn civ-drag-handle" title="Move">
                        <i class="fa-solid fa-grip"></i>
                    </div>
                    <div class="civ-icon-btn civ-gallery-btn-round" title="Open Gallery">
                        <i class="fa-solid fa-images"></i>
                    </div>
                </div>
                <div class="civ-nav-arrow civ-nav-left" title="Previous">
                    <i class="fa-solid fa-chevron-left"></i>
                </div>
                <div class="civ-nav-arrow civ-nav-right" title="Next">
                    <i class="fa-solid fa-chevron-right"></i>
                </div>
                <div style="width:100%; height:100%; display:flex; align-items:center;
                            justify-content:center; overflow:hidden;">
                    <img id="civ-target-img" src="${allImages[currentIndex]}"
                         style="width:100%; height:100%; object-fit:contain;" />
                </div>
            </div>`;

      $("body").append(html);
      const $win = $(`#${winId}`);
      const $img = $win.find("#civ-target-img");
      bringToFront($win);

      // Draggable & Resizable (locked to aspect ratio)
      if ($.fn.draggable)
        $win.draggable({ handle: ".civ-drag-handle", containment: "window" });
      if ($.fn.resizable)
        $win.resizable({
          handles: "se",
          aspectRatio: aspectRatio,
        });

      // Navigation (also updates aspect-ratio lock for the new image)
      const updateImage = (newIndex) => {
        if (newIndex < 0) newIndex = allImages.length - 1;
        if (newIndex >= allImages.length) newIndex = 0;
        currentIndex = newIndex;
        $img.attr("src", allImages[currentIndex]);

        const probe = new Image();
        probe.onload = () => {
          const newRatio = probe.naturalWidth / probe.naturalHeight;
          if ($.fn.resizable && newRatio > 0) {
            $win.resizable("option", "aspectRatio", newRatio);
          }
        };
        probe.onerror = () => {};
        probe.src = allImages[currentIndex];
      };

      // ── Gallery button (replaces close) ──
      $win.find(".civ-gallery-btn-round").on("click", () => {
        if (lastScannedImages.length > 0) {
          spawnGalleryWindow(lastScannedImages, lastScannedCharName);
        } else {
          performScan();
        }
      });
      $win.on("mousedown", function () {
        bringToFront($(this));
      });

      $win.find(".civ-nav-left").on("click", (e) => {
        e.stopPropagation();
        updateImage(currentIndex - 1);
      });
      $win.find(".civ-nav-right").on("click", (e) => {
        e.stopPropagation();
        updateImage(currentIndex + 1);
      });

      // Keyboard shortcuts
      $(document).on("keydown.civ-nav-" + winId, function (e) {
        if ($(`#${winId}`).length === 0) {
          $(document).off("keydown.civ-nav-" + winId);
          return;
        }
        if (e.key === "Escape") {
          $(document).off("keydown.civ-nav-" + winId);
          $win.remove();
          viewerState = null;
        }
      });

      // ── Store singleton state ──
      viewerState = { $win, $img, currentIndex, allImages, updateImage };
    };

    // Wait for preloader, or build immediately if already cached
    if (preloader.complete && preloader.naturalWidth > 0) {
      buildWindow();
    } else {
      preloader.onload = buildWindow;
      preloader.onerror = buildWindow;
    }
  }

  // --- 4. SCAN LOGIC ---
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

  // --- 5. INITIALIZATION LOOP ---
  let lastCharId = null;
  let autoOpenDoneForChar = null;
  function checkCharacterChange(ctx) {
    if (!ctx) return;
    const currentId = ctx.characterId;
    if (currentId === undefined || currentId === null) {
      // Chat closed — clean up all windows
      if (lastCharId !== null) {
        console.log(logPrefix, "Chat closed: Removing windows.");
        $(".civ-window-standard, .civ-window-frameless").remove();
        viewerState = null;
        lastScannedImages = [];
        lastScannedCharName = "";
      }
      lastCharId = null;
      autoOpenDoneForChar = null;
      return;
    }
    if (lastCharId !== currentId) {
      // Character changed — close old windows & clear singleton state
      console.log(logPrefix, "Character change detected.");
      $(".civ-window-standard, .civ-window-frameless").remove();
      viewerState = null;
      lastScannedImages = [];
      lastScannedCharName = "";
      autoOpenDoneForChar = null;
    }
    lastCharId = currentId;

    // Auto-open viewer on first detection of a new character with images
    if (autoOpenDoneForChar !== currentId) {
      const result = scanAndGetImages();
      if (result && result.images.length > 0) {
        spawnSingleImageWindow(0, result.images);
      }
      autoOpenDoneForChar = currentId;
    }
  }

  const mainLoop = setInterval(() => {
    checkCharacterChange(getSTContext());
  }, 1000);
});
