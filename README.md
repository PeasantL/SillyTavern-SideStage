Forked from baruvibe/SillyTavern-CharImgViewer

# 🖼️ Character Image Viewer for SillyTavern

A SillyTavern extension that automatically displays images from a character card in a sleek floating window, with a full gallery for browsing all detected images.

## ✨ Features

- **Auto-Open Viewer**: When a character is selected, the image viewer pops up automatically showing the first image.
- **Deep Scan**: Finds image URLs hidden anywhere in the character's data (Description, Author's Notes, Alternate Greetings, etc.).
- **Singleton Viewer**: Only one image window exists at a time — clicking thumbnails in the gallery simply swaps the image in-place.
- **Immersive Viewer**:
  - **Frameless Design**: Minimalist transparent window with floating controls that appear on hover.
  - **Transparent Background**: Perfect for viewing sprites and cutouts over your chat background.
  - **Slideshow Mode**: Navigate with on-screen arrows (`<` `>`), keyboard arrows, or `Escape` to close.
  - **Aspect-Ratio Resize**: Drag the bottom-right corner to resize, locked to the image's proportions.
- **Floating Gallery**: A draggable and resizable thumbnail grid for browsing all found images.
- **Quick Gallery Access**: Open the gallery from the image viewer via the gallery icon button.
- **Chat-Aware Cleanup**: Closing a chat automatically closes all viewer and gallery windows.
- **Seamless Integration**: Adds a shortcut button to the Character Header (next to the delete button) and the Extensions menu.

## 📥 Installation

1. Open **SillyTavern**.
2. Navigate to the **Extensions** menu (Puzzle piece icon).
3. Click on **Install Extension**.
4. Paste the URL of this repository:
   `https://https://github.com/PeasantL/SillyTavern-CharImgViewer`
5. Click **Install**.
6. **Reload** the page (F5).

## 🎮 How to Use

- **Auto**: Select a character — the image viewer opens automatically at the bottom-right.
- **Gallery**: Click the **Image Icon** in the character header, use the Extensions menu, or type `/gallery`.
- **From Viewer**: Click the gallery icon in the image viewer's overlay controls to open the full gallery.
- **Navigate**: Use on-screen `<` `>` arrows or keyboard `←` `→` keys. Press `Escape` to close the viewer.

## 📷 Screenshots

<img width="672" height="197" alt="arrowimg" src="https://github.com/user-attachments/assets/b1804f66-4da0-46bc-bb77-ecd694911214" />

## 📜 License

This project is open-source. Feel free to modify and contribute!
