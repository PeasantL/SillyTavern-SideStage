Image half forked from baruvibe/SillyTavern-CharImgViewer

# 🎭 SideStage for SillyTavern

A right-hand dock for group chats: who is in the scene, whose turn it is, and
what the scene looks like. SideStage merges two extensions — **Group Roster**
(the cast list and turn controls) and **Character Image Viewer** (the frameless
viewer and its gallery) — into one panel with one settings drawer.

## ✨ Features

### Roster

- **Rosters**: Named card lists you switch between, independent of group membership.
- **One-click membership**: Toggle any roster card in or out of the open group chat.
- **Force a turn**: Make a specific member speak next, bypassing the activation strategy. Anything typed in the message box is posted as your user turn first, so the forced reply answers it.
- **Per-roster Author's Note**: Each roster carries a note; a footer toggle fills the chat's Author's Note with it and clears it again.
- **Follows the chat**: Opens on group chats, closes elsewhere. The wand menu toggles it by hand.

### Images

- **Auto-Open Viewer**: When a character is selected, the frameless viewer appears showing the first image. Can be turned off in settings.
- **Greeting-Aware**: Opens on the image referenced by the greeting currently on screen, and follows along when you swipe to an alternate greeting or start a new chat. Toggled by **Change with Greeting**.
- **Deep Scan**: Finds image URLs hidden anywhere in the character's data (Description, Personality, Scenario, Alternate Greetings, character book, and so on).
- **Group Chat Support**: In a group, every member's card is scanned and the results are merged into one list.
- **Immersive Viewer**: Transparent frameless window with hover-revealed controls, slideshow navigation (`<` `>`, arrow keys, `Escape`), aspect-ratio-locked resize, auto-fit on image change, and a reset-position button.
- **Gallery**: A thumbnail grid of every image found, reached from the viewer's gallery button.
- **Chat-Aware Cleanup**: Closing a chat closes the viewer and gallery.

## 📥 Installation

1. Open **SillyTavern**.
2. Navigate to the **Extensions** menu (puzzle piece icon).
3. Click **Install Extension**.
4. Paste the URL of this repository:
   `https://github.com/PeasantL/SillyTavern-SideStage`
5. Click **Install**.
6. **Reload** the page (F5).

## 🎮 How to Use

- **Open the roster**: Wand menu → **SideStage**, or let it open itself when you enter a group chat.
- **Open the gallery**: The gallery button in the viewer's overlay controls.
- **Navigate images**: On-screen `<` `>` arrows or keyboard `←` `→`. `Escape` closes the viewer.
- **Settings**: Extensions panel → **SideStage**. One drawer, two sections:
  - *Roster* — pick, create, rename and delete rosters; edit the roster's Author's Note; add and remove cards.
  - *Images* — *Open the viewer automatically on character select* and *Change with Greeting*.

## 🔒 Privacy

Character cards can reference images on any server. Displaying them makes your browser fetch those URLs directly, which reveals your IP address and user agent to whoever hosts them. Only use cards you trust.

## 📜 License

This project is open-source. Feel free to modify and contribute!
