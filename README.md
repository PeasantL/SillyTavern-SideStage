Image half forked from baruvibe/SillyTavern-CharImgViewer

# 🎭 SideStage for SillyTavern

A right-hand strip for group chats: who is in the scene, how the scene opens,
whose turn it is, and what it all looks like. SideStage merges two extensions
— **Group Roster** (the cast list and turn controls) and **Character Image
Viewer** (the image viewer and its gallery) — into one strip down the right
edge, dressed in your SillyTavern theme, with one settings drawer.

## ✨ Features

### Roster

- **The cast is the group**: The panel lists the open group's members. Who is in the scene is who is unmuted: the panel's first toggle mutes and unmutes a member (SillyTavern's own mute), so SillyTavern's group panel and SideStage always agree. Muted members stay in the group but aren't picked to reply. A group that joins cards should use plain **Append** (group settings), not *Append (including muted)*, so only unmuted members' cards reach the prompt; world groups swap cards instead (below).
- **Entrances and exits**: The first toggle plays the move out in the chat. Bringing someone in unmutes them, the narrator says they entered the scene, then they take a full turn, written as their arrival. Sending someone off has them take a full turn, written as their exit, then the narrator says they left, then mutes them; if that turn brings no reply (stopped, or it failed), they stay in the scene. Anything typed in the message box is posted first. The narrator's two lines are editable in the settings drawer. Picking a layout and opening a new chat mute and unmute without any of this, as the layout's opening sets the scene.
- **Edit a card**: With the Character Editor's address set, ✎ beside a card's name opens it there.
- **Force a turn**: Make a specific member speak next, bypassing the activation strategy. Only members in the scene can: a muted member's button is greyed out. Anything typed in the message box is posted as your user turn first, so the forced reply answers it.
- **Per-group Author's Note**: Each world's group carries a note, written on the Character Editor's World tab; a footer toggle fills the chat's Author's Note with it and clears it again. A layout can override it for one scene. The toggle is saved with the chat, so it comes back on after a refresh and follows the note if you edit it or switch layout; typing over the note by hand turns it off.
- **Follows the chat**: Opens on group chats and on solo chats with a world's card, closes elsewhere. The wand menu toggles it by hand.

### World groups

A *world* is a lorebook shared by the cards of one setting, as made by the
Character Editor (a lorebook carrying SideStage's key, `extensions.sidestage`;
its cast is every card that links it). Every world gets its own group, made and
kept by SideStage:

- **Made for you**: When SillyTavern starts (or on ⟳), each world with at least one card and no group of its own gets one: named after the world, the world's cards in the scene, and SillyTavern's **Swap character cards** mode. Delete it and a new one is made (layouts are kept); a world with no cards yet gets its group when its first card joins.
- **Swap character cards**: Each reply's prompt has only the speaker's own card (description, personality, scenario, examples) and Character's Note, so the characters keep their own voices and their secrets: what one card says a character privately thinks never reaches another's turn. They know each other through the world's lorebook, whose character entries (one per card, written in the Character Editor) are in every prompt. Swapping doesn't throw the prompt cache away: a prefix cache such as DeepSeek's keeps every member's last turn, so each reply reuses the speaker's own, and only what was said since they last spoke (and their first turn) is read again. World groups made by earlier versions in Append mode are switched to Swap once; set one back in its group settings and it stays.
- **Members follow the world**: The group's members are exactly the world's cards. A card that joins the world joins the group, muted unless the selected layout puts it in the scene; a card that leaves the world, or any other member, leaves the group. The group's name follows the world's.
- **Kept in the world**: Which group is the world's, the group's note and its layouts are stored in the world's lorebook (`extensions.sidestage`), so they travel with the world and survive it being renamed. SideStage re-reads the lorebook before each save and only replaces that key, so lore edited elsewhere is kept. Which layout is selected belongs to the group and is kept in its SillyTavern group file (`sidestage_layout`), so picking one never rewrites the lorebook; a selection saved in the lorebook by an earlier version is moved onto the group once.
- **Layouts are edited in the Character Editor**: Its World tab makes, renames and deletes layouts and sets their narrator, note, order, cast and turns; SideStage picks which one is in use. Each save raises a revision number in the lorebook; when SideStage finds the layouts were saved elsewhere, it merges instead of overwriting, field by field, so nothing saved on one side is lost to the other. Edits made in the editor show up when you come back to the SillyTavern tab or window, open the group's chat or the settings drawer, or press ⟳.
- **Sync**: The group is brought in step when SillyTavern starts, when you open its chat, and when a card is edited or deleted in SillyTavern. Cards changed outside SillyTavern (in the Character Editor) reach it when you come back to the SillyTavern tab or window: SideStage asks for the character list and the lorebooks' settings (two requests, no lore entries), and when a card joined or left a world, or was renamed, it reloads the characters and syncs the groups; a lorebook made a world gets its group the same way. The ⟳ button in the panel header or the drawer does it by hand. Not while a reply is being generated: it catches up as soon as the reply (or the group's round) is done. The Character Editor shows whether the group has caught up.
- **Lore stays fresh**: SillyTavern keeps every lorebook it has read until the page is reloaded, so lore edited in the Character Editor wouldn't reach the chat, and SillyTavern's World Info editor would save its old copy over it. When you come back to the SillyTavern tab (or press ⟳), SideStage reads the lorebooks SillyTavern holds again and takes any that changed, reopening one shown in the World Info editor.
- **Solo chats join the group**: In a solo chat with a world's card, the panel shows the world's cast, with only that card in the scene. Bringing anyone else in invites them: the chat moves into a new chat of the world's group (not a new group, as SillyTavern's *Convert to group* would make), with the card in the scene and everyone else muted, and is opened there; then the guest enters as the first toggle brings anyone in. Anything typed in the message box is posted there first. The solo chat is deleted once the group's chat is saved and open, so a move that fails on the way leaves it where it was. In the solo chat the card's turn button is an ordinary send, the Author's Note toggle takes the group's note, and layouts are left to the group's chats.
- **Never deleted**: A group whose world is gone (deleted, or its cards unlinked) stays as an ordinary group, with its chats. Groups you make yourself are ordinary groups too: their members are managed in SillyTavern, SideStage mutes and unmutes them and forces turns, but they have no layouts or Author's Note.

### Greeting layouts

A layout is a saved answer to *how does this scene start*. Layouts belong to
worlds' groups (they are kept in the world's lorebook) and are written in the
Character Editor's World tab. Pick one from the panel footer; it takes hold
as soon as you select it, and again every time you start a new chat with that
group.

- **Who is in the scene**: Selecting a layout unmutes the members it puts in the scene and mutes the rest, and every new chat restores it. Muting a member from the panel changes the chat you're in without touching the layout, so a layout stays a fixed, repeatable arrangement.
- **Everyone in the scene has a turn**: Each card in the scene has its own turn in the layout: the message it posts when the scene opens. Turns are written for that layout alone, so they can follow on from each other, and they are kept in the layout rather than in the cards. A blank turn posts nothing, so a card can be present from the first line without speaking.
- **What order**: Each layout sets who opens the scene first. Each layout keeps its own order, so two scenes with the same cast can start from different people.
- **A narrator**: Optional scene-setting text posted ahead of the turns — where you are, what has just happened. It is posted as whoever answers the OOC, Morality and Scene asides (in a world's group, SideStage's narrator), with the same name and portrait as their answers; so are the roster's entrance and exit lines. In a group with nobody to answer the asides, it is SillyTavern's own narrator line, which reaches the prompt as narration rather than as anyone's dialogue.
- **Per-layout Author's Note**: Optional; blank falls back to the group's.
- **No layout**: Always available, and the default. A world group with no layout selected behaves as SillyTavern's groups always do, except that its muted members don't greet; ordinary groups always behave that way, muted members included.
- **No greeting pickers**: While a layout writes the opening (and for a world group's muted members), other extensions' greeting choices are skipped, so the Group Greetings extension's *Pick a greeting* popup doesn't appear for a greeting that would be replaced anyway.

> [!NOTE]
> The Character Editor's World tab can also write a layout's turns with
> DeepSeek, as one scene.

### Rewrite

Seven buttons in a row above the message box, reachable without opening the
panel: three rewrites, then a rule, then Narrate and three out-of-character
asides. Each rewrite is a one-shot request of its own rather than a trip through the chat's own
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
- **Narrate**: The narrator takes a turn in character and tells the story on:
  the world, what goes on around the characters, and side characters, who may
  speak. What you have typed in the message box is its direction (“the
  innkeeper says the rooms are full”) and is not posted as your turn; with the
  box empty, the narrator decides. In a world's group it is SideStage's
  narrator's turn, as for the asides; in a solo chat the reply is generated
  with the chat's card, told it is the narrator's, and posted under the
  narrator's name and portrait. Its prompt is the chat and the lorebook, with
  none of the asides' descriptions of the cast (in a solo chat SillyTavern
  still builds it with the chat's card). It is an ordinary turn: never ghosted,
  and a swipe of it narrates again with the same direction. It needs a
  narrator, so it does nothing in a group that is not a world's.
- **OOC**: Wraps what you have typed as `[OOC: ...]` and sends it the way a
  Quick Reply does — into the message box, then Send — so the answer is an
  ordinary reply with the usual prompt, context and streaming. In a world's
  group SideStage's narrator (hidden, muted, always the one who answers the
  asides) answers it as a turn of their own, and that turn's
  prompt also has the description of everyone in the scene (unmuted), since a
  world's group otherwise gives each turn only the speaker's own card, and
  leaves out SillyTavern's group nudge (*Group Nudge* prompt template,
  “[Write the next reply only as {{char}}.]”), swipes of it included. In a
  solo chat the narrator answers too: the reply is generated with the chat's
  card (the only one a solo chat has), told it is the narrator's and given the
  narrator's description, and is posted under the narrator's name and portrait;
  a swipe of it asks the narrator again.
- **Morality**: The same aside, asking what is evil about the scene as it
  stands. Nothing to type; the wording is editable in the settings drawer.
- **Scene**: The same aside, asking for a description of the scene as it
  stands. Nothing to type; the wording is editable in the settings drawer.
- **The narrator stays out of sight**: SideStage's narrator is a muted
  member of every world's group, so it can answer the asides, but
  SillyTavern's group views leave it out: the group list's names, count and
  portraits, and the member list of the group's own panel.
- **Ghost**: A toggle at the right end of the row. While it is on, both halves
  of an aside are ghosted when your next ordinary turn starts — ST's own
  *Exclude message from prompts* — so the exchange stays on screen but never
  reaches a later reply. Until then the answer can still be swiped. Turn it
  off to let the asides count as ordinary chat.
- **Which AI**: For the rewrites and spell check, the connection profile
  selected in SillyTavern's Connection Manager, or the active connection when
  none is selected. The asides are normal sends, so they use the active
  connection.
- **Watch it arrive**: On a connection profile, a reply streams in as it is
  written — into the message for the rewrites, into the message box for the
  spell check. Nothing is saved until the whole reply is in, and a result that
  fails its checks puts the original back.

### Images

- **One strip**: The images are the strip's bottom section, under the roster, full strip width and shaped to each image. Nothing floats, drags or resizes; the strip is fixed furniture beside the chat.
- **Auto-Open Viewer**: When the character on stage has images, the image section appears; when they have none, it goes away.
- **Greeting-Aware**: Opens on the image referenced by the greeting currently on screen, and follows along when you swipe to an alternate greeting or start a new chat. Toggled by **Change with Greeting**.
- **Deep Scan**: Finds image URLs hidden anywhere in the character's data (Description, Personality, Scenario, Alternate Greetings, character book, and so on).
- **Group Chat Support**: In a group, the images follow one member: the one focused in the roster, else whoever is taking the turn, else whoever spoke last. With none of those, every member's images are merged into one list.
- **Viewer**: Slideshow navigation (`<` `>`, arrow keys), shown on hover or tap. `Escape` closes it until the chat changes.
- **Gallery**: A thumbnail grid of every image found, reached from the viewer's gallery button. It takes the roster's place in the strip until closed.
- **Chat-Aware Cleanup**: Closing a chat closes the viewer and gallery.

### Character Editor lock

One setting, on by default: **Lock what the Character Editor manages**. The [Character Editor](https://github.com/PeasantL/character-editor) owns cards, worlds' lorebooks and their groups, so with the lock on SillyTavern can't change them behind its back. Buttons that would change them (rename, delete, import, …) stay where they are, greyed out like SillyTavern's own unavailable settings, and say where to go instead when clicked. Fields are never greyed, so everything stays readable: locked fields are muted (their text a little dimmer, on a darker background) but readable, text fields are read-only (you can still select, copy and scroll them, and trying to type, paste or delete in one says where to edit it), toggles and selects keep their state visible, and each has a tooltip saying it is managed by the Character Editor. A notice at the top of the card panel, and of the World Info editor for a world, says the same, with *Edit it there*.

- **Card fields**: Name, description, greetings, alternate greetings, tags, avatar, favourite, talkativeness and the advanced definitions are read-only while a card is open, in the panel and in its ⛶ expanded editor (creating a new card is untouched). The *Alternate Greetings* popup still opens so you can read them, but its fields are read-only and its add, delete and move buttons are locked.
- **Card actions**: *Create New Character*, import (button, external URL, files or links dropped on the page), bulk edit in the character list (its button and the long press on a character that also starts it, with its favourite, tag, duplicate, persona and delete), rename, duplicate, delete, *Link to World Info*, *Import Card Lore* and *Replace / Update*, and the `/rename-char`, `/char-delete`, `/char-duplicate` and `/char-update` commands.
- **Worlds**: A world's lorebook in the World Info editor: its entries are read-only (fields, on/off toggles, new, duplicate, move, delete, reordering and the sorting and memo tools), and it can't be renamed, duplicated or deleted; a notice atop the editor says so, as SillyTavern's own does over Advanced Formatting. SillyTavern saves a lorebook whole from its own copy, so an edit there could put back what the Character Editor changed meanwhile. Ordinary lorebooks are untouched.
- **World groups**: Deleting a world's group, and adding or removing its members (also `/member-add`, `/member-remove`). Muting stays free.
- **Saves**: SillyTavern still saves which chat a card last used, but only that, merged into the card file as it is now, instead of writing its whole (possibly stale) copy of the card over the editor's changes.

- **Links**: With the Character Editor's address set in the drawer (as this browser opens it, e.g. `https://host:1019/`), clicking a locked control's message opens what it names there (the card, the world), the card panel's and World Info's notices have *Edit it there*, ✎ beside each card in the roster opens that card, and ✎ beside the panel's layout picker opens the world at the selected layout. Links reuse one editor tab. Blank, there are no links.

### Tablet and home-screen app

- **Tablet layout**: On an iPad (a touch screen at least 744px both ways), SillyTavern's touch layout is kept in landscape too, and the strip takes a column beside the chat.
- **Status bar**: As a home-screen web app, the status bar stays black instead of taking the theme's Blur Tint, which SillyTavern writes into `theme-color` on every theme load. The bar's style and the first `theme-color` are read from SillyTavern's `index.html` before any extension runs, so those are set by whoever serves SillyTavern.

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
- **Bring a member in or send them off**: The first toggle on a card in the panel. They enter or leave in the chat, with a turn of their own.
- **Pick a layout**: The dropdown in the panel footer. It mutes and unmutes straight away, and reopens the scene the same way on every new chat.
- **Build a layout**: In the Character Editor: the world's **World** tab → *Group chat (SideStage)* → *Greeting layouts*. With the editor's address set, ✎ beside the panel's layout picker opens it there.
- **Rewrite a reply**: The button row above the message box. They run on the
  connection profile selected in SillyTavern; **Directive**,
  **Spell check** and **OOC** read the message box, so type there first.
- **Open the gallery**: The gallery button in the image's top-right corner.
- **Navigate images**: On-screen `<` `>` arrows or keyboard `←` `→`. `Escape` closes the viewer.
- **Settings**: Extensions panel → **SideStage**. One drawer, five sections:
  - *Group* — choose which world's group to look at; ⟳ syncs the world groups; ✎ opens the world in the Character Editor, where its Author's Note and layouts are written.
  - *Entrances and exits* — what the narrator says as someone enters or leaves.
  - *Rewrite* — what the **Morality** and **Scene** buttons ask.
  - *Character Editor* — its address, for the links into it, and the lock.
  - *Images* — *Change with Greeting*.

## 🧪 Tests

`node tests/merge.test.mjs` runs the layout merge over `tests/stage-merge-cases.json`, the cases the Character
Editor's own merge runs too, so the two apps keep merging each other's saves the same way.

## 🔒 Privacy

Character cards can reference images on any server. Displaying them makes your browser fetch those URLs directly, which reveals your IP address and user agent to whoever hosts them. Only use cards you trust.

## 📜 License

This project is open-source. Feel free to modify and contribute!
