Image half forked from baruvibe/SillyTavern-CharImgViewer

# 🎭 SideStage for SillyTavern

A right-hand dock for group chats: who is in the scene, how the scene opens,
whose turn it is, and what it all looks like. SideStage merges two extensions
— **Group Roster** (the cast list and turn controls) and **Character Image
Viewer** (the frameless viewer and its gallery) — into one panel with one
settings drawer.

## ✨ Features

### Roster

- **The cast is the group**: The panel lists the open group's members. Who is in the scene is who is unmuted: the panel's first toggle mutes and unmutes a member (SillyTavern's own mute), so SillyTavern's group panel and SideStage always agree. Muted members stay in the group but aren't picked to reply. Use the **Append** card join mode (group settings) so only unmuted members' cards reach the prompt.
- **Force a turn**: Make a specific member speak next, bypassing the activation strategy, muted or not. Anything typed in the message box is posted as your user turn first, so the forced reply answers it.
- **Per-group Author's Note**: Each group carries a note; a footer toggle fills the chat's Author's Note with it and clears it again. A layout can override it for one scene. The toggle is saved with the chat, so it comes back on after a refresh and follows the note if you edit it or switch layout; typing over the note by hand turns it off.
- **Follows the chat**: Opens on group chats, closes elsewhere. The wand menu toggles it by hand.

### World groups

A *world* is a lorebook shared by the cards of one setting, as made by the
Character Editor (a lorebook marked `extensions.character_editor.world`; its
cast is every card that links it). Every world gets its own group, made and
kept by SideStage:

- **Made for you**: When SillyTavern starts (or on ⟳), each world with at least one card and no group of its own gets one: named after the world, the world's cards in the scene, and the Append join mode. Delete it and a new one is made (layouts are kept); a world with no cards yet gets its group when its first card joins.
- **Members follow the world**: The group's members are exactly the world's cards. A card that joins the world joins the group, muted unless the selected layout puts it in the scene; a card that leaves the world, or any other member, leaves the group. The group's name follows the world's.
- **Kept in the world**: Which group is the world's, the group's note and its layouts are stored in the world's lorebook (`extensions.sidestage`), so they travel with the world and survive it being renamed. SideStage re-reads the lorebook before each save and only replaces that key, so lore edited elsewhere is kept.
- **Edit layouts in the Character Editor too**: Its World section edits the same layouts. Each save raises a revision number in the lorebook; when SideStage finds the layouts were saved elsewhere, it merges instead of overwriting, field by field (a layout's name, note, narrator and order, each card's entry), so edits from both sides are kept. Edits made in the editor show up when you open the group's chat or the settings drawer, or press ⟳.
- **Sync**: The group is brought in step when SillyTavern starts, when you open its chat, and when a card is edited or deleted in SillyTavern. Cards changed outside SillyTavern (in the Character Editor) reach it on a reload, or straight away with the ⟳ button in the panel header or the drawer.
- **Never deleted**: A group whose world is gone (deleted, or its cards unlinked) stays as an ordinary group, with its chats. Groups you make yourself are ordinary groups too: their members are managed in SillyTavern, and SideStage mutes and unmutes them.

### Greeting layouts

A layout is a saved answer to *how does this scene start*. Pick one from the
panel footer; it takes hold as soon as you select it, and again every time you
start a new chat with that group.

- **Who is in the scene**: Selecting a layout unmutes the members it puts in the scene and mutes the rest, and every new chat restores it. Muting a member from the panel changes the chat you're in without touching the layout, so a layout stays a fixed, repeatable arrangement.
- **Who opens it**: A card can be in the scene without posting a greeting, so someone can be present from the first line without speaking first.
- **Which greeting**: Pin a card to a specific opening line instead of ST's random pick, so a scene starts the same way every time. A pin remembers the greeting's text as well as its place, so it follows the greeting when the card's greetings are reordered.
- **What order**: Drag cards by the grip to set who opens the scene first. Each layout keeps its own order, so two scenes with the same cast can start from different people.
- **A narrator**: Optional scene-setting text posted ahead of every greeting — where you are, what has just happened. It reaches the prompt as narration rather than as anyone's dialogue.
- **Per-layout Author's Note**: Optional; blank falls back to the group's.
- **No layout**: Always available, and the default. Groups you haven't set a layout for behave as they always did, except that in a world group the muted members don't greet.

> [!NOTE]
> Only **group greetings** can be pinned — not `first_mes` and not the ordinary
> alternate greetings, which are written for a solo chat where the character has
> the scene to itself. Add them to a card with
> [Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings),
> whose editor sits beside **Alt. Greetings** on the character. A card with no
> group greetings can still greet — it just falls through to whatever ST would
> have picked.

### Rewrite

Six buttons in a row above the message box, reachable without opening the
panel: three rewrites, then a rule, then three out-of-character asides. Each is
a one-shot request of its own rather than a trip through the chat's own
generation, so none of them rebuild or re-send the prompt your conversation is
built on: a rewrite costs one small call and leaves the chat where it was.

- **Perspective**: Rewrites the latest character reply into one consistent
  narrative perspective — everyone in third person, you in second — and changes
  nothing else. Spoken dialogue is left exactly as it is. Only that passage is
  sent, with no chat history behind it: whose pronouns are whose is answerable
  from the passage alone.
- **Directive**: Rewrites the latest character reply to follow whatever you have
  typed in the message box. The chat goes up with it, so an instruction that
  only makes sense in light of the scene still lands. The rewrite arrives as a
  new swipe on that reply rather than overwriting it, so the original is still a
  chevron away and a directive you don't like costs nothing. The box is cleared
  once the rewrite is applied.
- **Spell check**: Copy-edits what you have typed, in place. Typos, punctuation
  and clear grammar errors; your word choice, tone and line breaks are left
  alone, as are dialect, fragments, invented names and roleplay formatting.
  Nothing is sent to the chat, and `{{macros}}` come back intact.
- **OOC**: Posts what you have typed as an out-of-character question and
  answers it in the voice of whoever spoke last.
- **Morality**: The same aside, asking what is evil about the scene as it
  stands. Nothing to type; the wording is editable in the settings drawer.
- **Scene**: The same aside, asking for a description of the scene as it
  stands. Nothing to type; the wording is editable in the settings drawer.
- **Ghost**: A toggle at the right end of the row. While it is on, both halves
  of an aside are ghosted once they land — ST's own *Exclude message from
  prompts* — so the exchange stays on screen but never reaches a later reply.
  Turn it off to let the asides count as ordinary chat.
- **Which AI**: The connection profile selected in SillyTavern's Connection
  Manager, or the active connection when none is selected.
- **How much chat goes with an aside**: The whole chat, which is what an answer
  about the scene needs.
- **Watch it arrive**: On a connection profile, a reply streams in as it is
  written — into the message for the rewrites, into the message box for the
  spell check. Nothing is saved until the whole reply is in, and a result that
  fails its checks puts the original back.

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
- **Mute or unmute a member**: The first toggle on a card in the panel.
- **Pick a layout**: The dropdown in the panel footer. It mutes and unmutes straight away, and reopens the scene the same way on every new chat.
- **Build a layout**: Extensions panel → **SideStage** → *Greeting layouts*. Add one, then set each card's *In scene*, *Greets* and *Greeting*, and drag the rows into the order you want the scene to open in.
- **Rewrite a reply**: The button row above the message box. They run on the
  connection profile selected in SillyTavern; **Directive**,
  **Spell check** and **OOC** read the message box, so type there first.
- **Open the gallery**: The gallery button in the viewer's overlay controls.
- **Navigate images**: On-screen `<` `>` arrows or keyboard `←` `→`. `Escape` closes the viewer.
- **Settings**: Extensions panel → **SideStage**. One drawer, four sections:
  - *Group* — choose which group you're editing (and see whether it is a world's group); ⟳ syncs the world groups; edit its Author's Note.
  - *Greeting layouts* — add, rename and delete layouts; set the narrator, the note override, and the per-card matrix.
  - *Rewrite* — what the **Morality** and **Scene** buttons ask.
  - *Images* — *Open the viewer automatically on character select* and *Change with Greeting*.

## 🔒 Privacy

Character cards can reference images on any server. Displaying them makes your browser fetch those URLs directly, which reveals your IP address and user agent to whoever hosts them. Only use cards you trust.

## 📜 License

This project is open-source. Feel free to modify and contribute!
