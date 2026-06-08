jQuery(async function () {
  const extensionName = "CharImgViewer";
  const logPrefix = `[${extensionName}]`;

  console.log(logPrefix, "Starting V23 (Back to stability - Active Loop)...");

  // --- 0. CSS STYLES ---
  const cssStyle = `
    <style>
        .civ-gallery-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 10px; padding: 10px;
        }
        .civ-thumb {
            width: 100%; height: 120px; object-fit: cover;
            cursor: pointer; border-radius: 4px; transition: transform 0.2s;
            border: 2px solid transparent;
        }
        .civ-thumb:hover {
            border-color: var(--smart-theme-color, #007bff);
            transform: scale(1.05);
        }

        /* GALLERY Window */
        .civ-window-standard {
            background-color: var(--smart-background-color, #1a1a1a);
            border: 1px solid var(--smart-border-color, #444);
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            display: flex; flex-direction: column; position: fixed;
            border-radius: 8px; overflow: hidden;
            z-index: 500; 
        }
        .civ-header {
            background-color: var(--smart-app-bar-color, #2a2a2a);
            padding: 8px 12px; cursor: move;
            display: flex; justify-content: space-between; align-items: center;
            font-weight: bold; border-bottom: 1px solid #444;
            color: var(--smart-text-color, #eee);
        }

        /* IMAGE Window (Transparent & Slideshow) */
        .civ-window-frameless {
            position: fixed;
            background: transparent;
            box-shadow: 0 5px 25px rgba(0,0,0,0.2); 
            display: flex; flex-direction: column;
            border-radius: 8px; overflow: hidden;
            border: 1px solid rgba(255,255,255,0.05);
            z-index: 500;
        }
        
        .civ-overlay-container {
            position: absolute; top: 15px; right: 15px;
            display: flex; align-items: center; gap: 15px;
            z-index: 20;
            opacity: 0; transition: opacity 0.2s ease-in-out;
        }
        .civ-window-frameless:hover .civ-overlay-container { opacity: 1; }

        .civ-icon-btn {
            color: rgba(255, 255, 255, 0.9);
            font-size: 18px; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            width: 30px; height: 30px; border-radius: 50%;
            transition: all 0.2s;
            text-shadow: 0 1px 3px rgba(0,0,0,0.8);
        }
        .civ-icon-btn:hover {
            color: white; background: rgba(255,255,255,0.15); text-shadow: none;
        }
        
        .civ-drag-handle { cursor: grab; }
        .civ-drag-handle:active { cursor: grabbing; }
        .civ-gallery-btn-round:hover { background: rgba(100, 180, 255, 0.4); }

        /* Navigation Arrows */
        .civ-nav-arrow {
            position: absolute; top: 50%; transform: translateY(-50%);
            width: 40px; height: 60px;
            display: flex; align-items: center; justify-content: center;
            font-size: 24px; color: rgba(255,255,255,0.6);
            cursor: pointer; z-index: 15;
            transition: all 0.2s;
            opacity: 0; 
        }
        .civ-window-frameless:hover .civ-nav-arrow { opacity: 1; }
        .civ-nav-arrow:hover { color: white; background: rgba(0,0,0,0.3); border-radius: 4px; }
        .civ-nav-left { left: 0; }
        .civ-nav-right { right: 0; }

        .civ-window-frameless .ui-resizable-se {
            width: 25px !important; height: 25px !important;
            right: 0 !important; bottom: 0 !important;
            background: radial-gradient(circle at bottom right, rgba(255,255,255,0.4) 0%, transparent 50%);
            border-bottom-right-radius: 8px;
            opacity: 0; transition: opacity 0.2s;
            cursor: se-resize;
        }
        .civ-window-frameless:hover .ui-resizable-se { opacity: 1; }
    </style>
    `;
  $("head").append(cssStyle);

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
        <div id="${winId}" class="civ-window-standard" style="top: 100px; left: 100px; width: 600px; height: 400px;">
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
  //  SINGLETON viewer: 18vw wide | bottom-right | 10px from bottom | aspect-ratio locked
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
      // Fixed width: 18vw
      const winW = window.innerWidth * 0.18;
      // Height follows the image's aspect ratio
      const winH = winW / aspectRatio;

      // Bottom-right corner, 10px from bottom, flush with right edge
      const top = window.innerHeight - winH - 10;
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
        if (e.key === "ArrowLeft") updateImage(currentIndex - 1);
        if (e.key === "ArrowRight") updateImage(currentIndex + 1);
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

  // --- 5. ROBUST INITIALIZATION (LOOP) ---
  function injectIntoCharHeader() {
    const deleteBtn = $("#delete_button");
    if (deleteBtn.length && $("#civ-header-btn").length === 0) {
      const btnHtml = `
                <div id="civ-header-btn" class="menu_button" title="Image Gallery" style="margin-right:2px;">
                    <i class="fa-solid fa-images"></i>
                </div>
            `;
      deleteBtn.before(btnHtml);
      $("#civ-header-btn").on("click", (e) => {
        e.preventDefault();
        performScan();
      });
      console.log(logPrefix, "Button injected into header.");
    }
  }

  let lastCharId = null;
  let autoOpenDoneForChar = null;
  function checkCharacterChange(ctx) {
    if (!ctx) return;
    const currentId = ctx.characterId;
    if (currentId === undefined || currentId === null) {
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

  let registered = false;
  const mainLoop = setInterval(() => {
    const ctx = getSTContext();
    if (ctx && ctx.registerSlashCommand && !registered) {
      ctx.registerSlashCommand(
        "gallery",
        performScan,
        [],
        "Opens the gallery",
        true,
        true,
      );
      registered = true;
    }
    if ($("#extensions_settings").length && $("#civ-drawer-btn").length === 0) {
      const drawerHtml = `
                <div class="extension_settings"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Char Image Viewer</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><button id="civ-drawer-btn" class="menu_button"><i class="fa-solid fa-images"></i> Open Gallery</button></div></div></div>`;
      $("#extensions_settings").append(drawerHtml);
      $(document).on("click", "#civ-drawer-btn", performScan);
    }
    injectIntoCharHeader();
    checkCharacterChange(ctx);
  }, 1000);
});
