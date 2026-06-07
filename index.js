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
        .civ-close-btn-round:hover { background: rgba(255, 50, 50, 0.4); }

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
    $('head').append(cssStyle);

    // --- 1. UTILITIES ---
    const httpImageRegex = /(https?:\/\/[^\s)"]+?\.(?:png|jpg|jpeg|gif|webp))/gi;
    const imgSrcRegex = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+?\.(?:png|jpg|jpeg|gif|webp))["']/gi;

    function getSTContext() {
        if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) return null;
        return SillyTavern.getContext();
    }

    function deepScanForImages(obj, foundSet, visited = new WeakSet()) {
        if (!obj || typeof obj !== 'object') {
            if (typeof obj === 'string') {
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
        Object.values(obj).forEach(value => deepScanForImages(value, foundSet, visited));
    }

    function bringToFront($win) {
        $('.civ-window-standard, .civ-window-frameless').css('z-index', 500);
        $win.css('z-index', 501);
    }

    // --- 2. DISPLAY ---
    function spawnGalleryWindow(images, charName) {
        const winId = 'civ-main-gallery-window';
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

        $('body').append(html);
        const $win = $(`#${winId}`);
        bringToFront($win);

        if ($.fn.draggable) $win.draggable({ handle: ".civ-header", containment: "window" });
        if ($.fn.resizable) $win.resizable();

        $win.find('.civ-close-btn').on('click', () => $win.remove());
        $win.on('mousedown', function() { bringToFront($(this)); });
        
        $win.find('.civ-thumb').on('click', function() {
            spawnSingleImageWindow($(this).data('index'), images);
        });
    }

    // ──────────────────────────────────────────────
    //  UPDATED: Aspect-ratio-aware image viewer
    // ──────────────────────────────────────────────
    function spawnSingleImageWindow(startIndex, allImages) {
        const winId = `civ-img-${Date.now()}`;
        let currentIndex = startIndex;

        // Pre-load the image to read its natural dimensions
        const preloader = new Image();
        preloader.src = allImages[currentIndex];

        /**
         * Builds the window once we know the image dimensions.
         * Falls back to 400×300 if the image fails to load.
         */
        const buildWindow = () => {
            const natW = preloader.naturalWidth || 400;
            const natH = preloader.naturalHeight || 300;
            const aspectRatio = natW / natH;

            // Constrain initial size to 85% of viewport (max 1200×900)
            const maxW = Math.min(window.innerWidth * 0.85, 1200);
            const maxH = Math.min(window.innerHeight * 0.85, 900);

            let winW, winH;
            if (natW / natH > maxW / maxH) {
                // Image is wider than the available area → width-constrained
                winW = Math.min(natW, maxW);
                winH = winW / aspectRatio;
            } else {
                // Image is taller → height-constrained
                winH = Math.min(natH, maxH);
                winW = winH * aspectRatio;
            }
            // Floor to reasonable minimums
            winW = Math.max(winW, 200);
            winH = Math.max(winH, 150);

            // Center in viewport
            const top  = Math.max(20, (window.innerHeight - winH) / 2);
            const left = Math.max(20, (window.innerWidth  - winW) / 2);

            const html = `
            <div id="${winId}" class="civ-window-frameless"
                 style="top: ${top}px; left: ${left}px; width: ${winW}px; height: ${winH}px;">
                <div class="civ-overlay-container">
                    <div class="civ-icon-btn civ-drag-handle" title="Move">
                        <i class="fa-solid fa-grip"></i>
                    </div>
                    <div class="civ-icon-btn civ-close-btn-round" title="Close">
                        <i class="fa-solid fa-xmark"></i>
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

            $('body').append(html);
            const $win = $(`#${winId}`);
            const $img = $win.find('#civ-target-img');
            bringToFront($win);

            // --- Draggable & Resizable (LOCKED to aspect ratio) ---
            if ($.fn.draggable) $win.draggable({ handle: ".civ-drag-handle", containment: "window" });
            if ($.fn.resizable) $win.resizable({
                handles: "se",
                aspectRatio: aspectRatio   // ← THE KEY CHANGE: lock to image ratio
            });

            // --- Close ---
            $win.find('.civ-close-btn-round').on('click', () => {
                $(document).off('keydown.civ-nav-' + winId);
                $win.remove();
            });
            $win.on('mousedown', function() { bringToFront($(this)); });

            // --- Navigation (also updates aspect-ratio lock) ---
            const updateImage = (newIndex) => {
                if (newIndex < 0) newIndex = allImages.length - 1;
                if (newIndex >= allImages.length) newIndex = 0;
                currentIndex = newIndex;
                $img.attr('src', allImages[currentIndex]);

                // Re-read the new image's dimensions and update the resizable constraint
                const probe = new Image();
                probe.onload = () => {
                    const newRatio = probe.naturalWidth / probe.naturalHeight;
                    if ($.fn.resizable && newRatio > 0) {
                        $win.resizable('option', 'aspectRatio', newRatio);
                    }
                };
                probe.onerror = () => {}; // keep old ratio on error
                probe.src = allImages[currentIndex];
            };

            $win.find('.civ-nav-left').on('click', (e) => {
                e.stopPropagation(); updateImage(currentIndex - 1);
            });
            $win.find('.civ-nav-right').on('click', (e) => {
                e.stopPropagation(); updateImage(currentIndex + 1);
            });

            // --- Keyboard shortcuts ---
            $(document).on('keydown.civ-nav-' + winId, function(e) {
                if ($(`#${winId}`).length === 0) {
                    $(document).off('keydown.civ-nav-' + winId);
                    return;
                }
                if (e.key === 'ArrowLeft')  updateImage(currentIndex - 1);
                if (e.key === 'ArrowRight') updateImage(currentIndex + 1);
                if (e.key === 'Escape') {
                    $(document).off('keydown.civ-nav-' + winId);
                    $win.remove();
                }
            });
        };

        // Wait for the preloader, or build immediately if already cached
        if (preloader.complete && preloader.naturalWidth > 0) {
            buildWindow();
        } else {
            preloader.onload  = buildWindow;
            preloader.onerror = buildWindow; // fallback to 400×300
        }
    }

    // --- 4. SCAN LOGIC ---
    function performScan() {
        const ctx = getSTContext();
        if (!ctx) return;
        const id = ctx.characterId;
        if (id === undefined || id === null) {
            toastr.warning("No character open.", extensionName);
            return;
        }
        const char = ctx.characters[id];
        if (!char) return;

        let uniqueImages = new Set();
        deepScanForImages(char, uniqueImages);
        if (char.avatar && char.avatar.match(httpImageRegex)) uniqueImages.add(char.avatar);
        const images = Array.from(uniqueImages);

        if (images.length === 0) {
            toastr.info(`No images found for ${char.name}.`, extensionName);
            return;
        }
        spawnGalleryWindow(images, char.name);
    }

    // --- 5. ROBUST INITIALIZATION (LOOP) ---
    function injectIntoCharHeader() {
        const deleteBtn = $('#delete_button');
        if (deleteBtn.length && $('#civ-header-btn').length === 0) {
            const btnHtml = `
                <div id="civ-header-btn" class="menu_button" title="Image Gallery" style="margin-right:2px;">
                    <i class="fa-solid fa-images"></i>
                </div>
            `;
            deleteBtn.before(btnHtml);
            $('#civ-header-btn').on('click', (e) => { e.preventDefault(); performScan(); });
            console.log(logPrefix, "Button injected into header.");
        }
    }

    let lastCharId = null;
    function checkCharacterChange(ctx) {
        if (!ctx) return;
        const currentId = ctx.characterId;
        if (lastCharId !== null && lastCharId !== undefined && lastCharId !== currentId) {
            if ($('.civ-window-standard, .civ-window-frameless').length > 0) {
                console.log(logPrefix, "Character change: Closing.");
                $('.civ-window-standard, .civ-window-frameless').remove();
            }
        }
        lastCharId = currentId;
    }

    let registered = false;
    const mainLoop = setInterval(() => {
        const ctx = getSTContext();
        if (ctx && ctx.registerSlashCommand && !registered) {
            ctx.registerSlashCommand("gallery", performScan, [], "Opens the gallery", true, true);
            registered = true;
        }
        if ($('#extensions_settings').length && $('#civ-drawer-btn').length === 0) {
            const drawerHtml = `
                <div class="extension_settings"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Char Image Viewer</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><button id="civ-drawer-btn" class="menu_button"><i class="fa-solid fa-images"></i> Open Gallery</button></div></div></div>`;
            $('#extensions_settings').append(drawerHtml);
            $(document).on('click', '#civ-drawer-btn', performScan);
        }
        injectIntoCharHeader();
        checkCharacterChange(ctx);
    }, 1000);
});
