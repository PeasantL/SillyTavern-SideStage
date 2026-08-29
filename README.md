Forked from baruvibe/SillyTavern-CharImgViewer

# 🖼️ Character Image Viewer for SillyTavern

A SillyTavern extension that automatically displays images from a character card in a sleek floating window, with a full gallery for browsing all detected images.

## ✨ Features

- **Auto-Open Viewer**: When a character is selected, the image viewer pops up automatically showing the first image. Can be turned off in the extension settings.
- **Greeting-Aware**: The viewer opens on the image referenced by the greeting currently on screen, and follows along when you swipe to an alternate greeting or start a new chat. Toggled by the **Change with Greeting** setting.
- **Deep Scan**: Finds image URLs hidden anywhere in the character's data (Description, Personality, Scenario, Alternate Greetings, character book, and so on).
- **Group Chat Support**: In a group, every member's card is scanned and the results are merged into one list.
- **Immersive Viewer**:
  - **Frameless Design**: Minimalist transparent window with floating controls that appear on hover.
  - **Transparent Background**: Perfect for viewing sprites and cutouts over your chat background.
  - **Slideshow Mode**: Navigate with on-screen arrows (`<` `>`), keyboard arrows, or `Escape` to close.
  - **Aspect-Ratio Resize**: Drag the bottom-right corner to resize, locked to the image's proportions.
  - **Auto-Fit**: Navigating to an image with a different aspect ratio re-shapes the window to match, keeping its width and its bottom-right corner.
  - **Reset Position**: A button in the overlay controls snaps the viewer back to its spawn spot (bottom-right, just above the input bar).
- **Floating Gallery**: A draggable and resizable thumbnail grid for browsing all found images.
- **Quick Gallery Access**: Open the gallery from the image viewer via the gallery icon button.
- **Chat-Aware Cleanup**: Closing a chat automatically closes all viewer and gallery windows.

## 📥 Installation

1. Open **SillyTavern**.
2. Navigate to the **Extensions** menu (Puzzle piece icon).
3. Click on **Install Extension**.
4. Paste the URL of this repository:
   `https://github.com/PeasantL/SillyTavern-CharImgViewer`
5. Click **Install**.
6. **Reload** the page (F5).

## 🎮 How to Use

- **From Viewer**: Click the gallery icon in the image viewer's overlay controls to open the full gallery.
- **Navigate**: Use on-screen `<` `>` arrows or keyboard `←` `→` keys. Press `Escape` to close the viewer.
- **Settings**: Extensions panel → **Character Image Viewer**.
  - *Open the viewer automatically on character select* — note this is the only way the viewer appears, so disabling it makes the extension inert until it is switched back on.
  - *Change with Greeting* — whether the viewer tracks the greeting on screen. Off means it opens on the first image found and only moves when you navigate it.

## 🔒 Privacy

Character cards can reference images on any server. Displaying them makes your browser fetch those URLs directly, which reveals your IP address and user agent to whoever hosts them. Only use cards you trust.

## 📜 License

This project is open-source. Feel free to modify and contribute!
