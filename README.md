Image half forked from baruvibe/SillyTavern-CharImgViewer

# 🎭 SideStage for SillyTavern

A right-hand dock for group chats: who is in the scene, how the scene opens,
whose turn it is, and what it all looks like. SideStage merges two extensions
— **Group Roster** (the cast list and turn controls) and **Character Image
Viewer** (the frameless viewer and its gallery) — into one panel with one
settings drawer.

## ✨ Features

### Roster

- **One roster per group**: Each group gets a roster the first time you open it, seeded from its current cast. Nothing to name, pick or delete — it follows the group, and goes when the group does.
- **A bench, not just the cast**: The roster is the wider pool of cards for that group; membership is the subset currently in the chat.
- **One-click membership**: Toggle any roster card in or out of the open group chat.
- **Force a turn**: Make a specific member speak next, bypassing the activation strategy. Anything typed in the message box is posted as your user turn first, so the forced reply answers it.
- **Per-group Author's Note**: Each group carries a note; a footer toggle fills the chat's Author's Note with it and clears it again. A layout can override it for one scene.
- **Follows the chat**: Opens on group chats, closes elsewhere. The wand menu toggles it by hand.

### Greeting layouts

A layout is a saved answer to *how does this scene start*. Pick one from the
panel footer; it takes hold as soon as you select it, and again every time you
start a new chat with that group.

- **Who is in the scene**: Selecting a layout rewrites the group's cast to the cards it lists, in roster order, and every new chat restores it. Toggling membership in the panel changes the cast for the chat you're in without touching the layout, so a layout stays a fixed, repeatable arrangement.
- **Who opens it**: A card can be in the scene without posting a greeting, so someone can be present from the first line without speaking first.
- **Which greeting**: Pin a card to a specific opening line instead of ST's random pick, so a scene starts the same way every time.
- **What order**: Drag cards by the grip to set who opens the scene first. Each layout keeps its own order, so two scenes with the same cast can start from different people.
- **A narrator**: Optional scene-setting text posted ahead of every greeting — where you are, what has just happened. It reaches the prompt as narration rather than as anyone's dialogue.
- **Per-layout Author's Note**: Optional; blank falls back to the group's.
- **No layout**: Always available, and the default. Groups you haven't set a layout for behave exactly as they always did.

> [!NOTE]
> Only **group greetings** can be pinned — not `first_mes` and not the ordinary
> alternate greetings, which are written for a solo chat where the character has
> the scene to itself. Add them to a card with
> [Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings),
> whose editor sits beside **Alt. Greetings** on the character. A card with no
> group greetings can still greet — it just falls through to whatever ST would
> have picked.

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
- **Pick a layout**: The dropdown in the panel footer. It reshapes the cast straight away, and reopens the scene the same way on every new chat.
- **Build a layout**: Extensions panel → **SideStage** → *Greeting layouts*. Add one, then set each card's *In scene*, *Greets* and *Greeting*, and drag the rows into the order you want the scene to open in.
- **Open the gallery**: The gallery button in the viewer's overlay controls.
- **Navigate images**: On-screen `<` `>` arrows or keyboard `←` `→`. `Escape` closes the viewer.
- **Settings**: Extensions panel → **SideStage**. One drawer, three sections:
  - *Roster* — choose which group you're editing; edit its Author's Note; add and remove cards.
  - *Greeting layouts* — add, rename and delete layouts; set the narrator, the note override, and the per-card matrix.
  - *Images* — *Open the viewer automatically on character select* and *Change with Greeting*.

## 🔒 Privacy

Character cards can reference images on any server. Displaying them makes your browser fetch those URLs directly, which reveals your IP address and user agent to whoever hosts them. Only use cards you trust.

## 📜 License

This project is open-source. Feel free to modify and contribute!
