/**
 * SideStage — the right-hand dock: who is in the scene, whose turn it is, and
 * what the scene looks like.
 *
 * Merged from two extensions, Group Roster (the cast list, turn controls and
 * Author's Note) and Character Image Viewer (the frameless viewer and its
 * gallery). The two halves keep their original accessors on purpose — the
 * roster imports live bindings from script.js, the image half reads
 * SillyTavern.getContext() — so the merge stayed a move of working code rather
 * than a rewrite of it.
 */
import {
    eventSource,
    event_types,
    characters,
    getThumbnailUrl,
    isGenerating,
    saveSettingsDebounced,
    Generate,
    menu_type,
    sendMessageAsUser,
    extractMessageBias,
    unshallowCharacter,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    groups,
    selected_group,
    openGroupId,
    editGroup,
    unshallowGroupMembers,
    select_group_chats,
} from '../../../group-chats.js';
import { waitUntilCondition, uuidv4 } from '../../../utils.js';
import { t } from '../../../i18n.js';
import { Popup } from '../../../popup.js';

// ═══════════════════════ Group roster ═══════════════════════


const MODULE_NAME = 'groupRoster';
const PANEL_ID = 'groupRoster';
/**
 * Avatar the viewer is pinned to, or null to follow whoever spoke last.
 * Deliberately not persisted: it is a way to look at one character for a
 * moment, not a property of the roster, so it resets with the chat.
 * @type {string|null}
 */
let focusedAvatar = null;

/**
 * @typedef {object} LayoutEntry
 * @property {boolean} active Whether the card is in the group for this scene
 * @property {boolean} greets Whether the card posts an opening message
 * @property {number|null} greeting Index into the card's group greetings, or null for random
 */

/**
 * A way to open a scene with this group's cast. Card order is the roster's, so
 * a layout only stores what varies: who is in it, who speaks, and with what.
 * @typedef {object} Layout
 * @property {string} id
 * @property {string} name
 * @property {string} note Author's Note for this scene; blank falls back to the group's
 * @property {Record<string, LayoutEntry>} cards Keyed by avatar file name; absent means inactive
 */

/**
 * @typedef {object} Roster
 * @property {string[]} cards Avatar file names in this group's pool, in display order
 * @property {string} note Author's Note the footer toggle fills the chat with
 * @property {Layout[]} layouts Scenes that can be opened with this cast
 * @property {string} activeLayoutId Id of the selected layout, or '' for none
 */

const rosterDefaults = {
    /** @type {Record<string, Roster>} Rosters by group id. One per group, created on demand. */
    groups: {},
    /**
     * Free-standing rosters from before rosters followed groups. Kept only so
     * their card lists can be imported into a group, never edited in place.
     * @type {{id: string, name: string, cards: string[], note: string}[]}
     */
    legacyRosters: [],
};

/**
 * Group whose roster the settings drawer edits. Empty means "follow the open
 * group", which is the state it returns to whenever the chat changes.
 * @type {string}
 */
let settingsGroupId = '';

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(rosterDefaults);
    }

    const settings = extension_settings[MODULE_NAME];

    for (const key of Object.keys(rosterDefaults)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(rosterDefaults[key]);
        }
    }

    // Migration from the single flat card list this extension shipped with.
    if (Array.isArray(settings.cards)) {
        if (settings.cards.length) {
            settings.legacyRosters.push({ id: uuidv4(), name: t`Default`, cards: settings.cards, note: '' });
        }
        delete settings.cards;
    }

    // Migration from free-standing rosters. A roster was deliberately not tied
    // to a group, so there is nothing to bind these to without guessing; they
    // are parked for a manual import instead of being assigned automatically.
    if (Array.isArray(settings.rosters)) {
        settings.legacyRosters.push(...settings.rosters.filter(x => x?.cards?.length || x?.note));
        delete settings.rosters;
        delete settings.activeRosterId;
    }

    for (const roster of Object.values(settings.groups)) {
        if (!Array.isArray(roster.cards)) {
            roster.cards = [];
        }
        if (typeof roster.note !== 'string') {
            roster.note = '';
        }
        if (!Array.isArray(roster.layouts)) {
            roster.layouts = [];
        }
        if (typeof roster.activeLayoutId !== 'string') {
            roster.activeLayoutId = '';
        }

        for (const layout of roster.layouts) {
            if (typeof layout.note !== 'string') {
                layout.note = '';
            }
            if (!layout.cards || typeof layout.cards !== 'object') {
                layout.cards = {};
            }
        }

        // A layout deleted from another tab, or settings rolled back, must not
        // leave the roster pointing at nothing.
        if (!roster.layouts.some(x => x.id === roster.activeLayoutId)) {
            roster.activeLayoutId = '';
        }
    }

    return settings;
}

/**
 * The roster for one group, created on first use and seeded from that group's
 * current members so a group opens with its cast already in the panel.
 * @param {string} [groupId]
 * @param {object} [options]
 * @param {boolean} [options.create=true] Create the roster if it doesn't exist yet
 * @returns {Roster|null}
 */
function getRoster(groupId, { create = true } = {}) {
    if (!groupId) {
        return null;
    }

    const settings = getSettings();

    if (!settings.groups[groupId] && create) {
        const group = groups.find(x => x.id === groupId);
        settings.groups[groupId] = { cards: [...(group?.members ?? [])], note: '' };
        saveSettingsDebounced();
    }

    return settings.groups[groupId] ?? null;
}

/** @returns {Roster|null} The roster for the open group chat. */
function getActiveRoster() {
    return getRoster(getCurrentGroup()?.id);
}

/** @returns {string[]} Avatar file names in the open group's roster. */
function getActiveCards() {
    return getActiveRoster()?.cards ?? [];
}

/** @returns {string} Id of the group the settings drawer is editing. */
function getSettingsGroupId() {
    if (settingsGroupId && groups.some(x => x.id === settingsGroupId)) {
        return settingsGroupId;
    }

    return getCurrentGroup()?.id ?? groups[0]?.id ?? '';
}

/** @returns {Roster|null} The roster the settings drawer edits. */
function getSettingsRoster() {
    return getRoster(getSettingsGroupId());
}

/**
 * @param {Roster|null} roster
 * @returns {Layout|null} The roster's selected layout, or null when none is.
 */
function getActiveLayout(roster) {
    return roster?.layouts.find(x => x.id === roster.activeLayoutId) ?? null;
}

/**
 * A card's settings within a layout. Cards added to the roster after the layout
 * was built are absent, and default to sitting the scene out, so growing the
 * roster never quietly rewrites an existing scene.
 * @param {Layout} layout
 * @param {string} avatar
 * @returns {LayoutEntry}
 */
function getLayoutEntry(layout, avatar) {
    return layout.cards[avatar] ?? { active: false, greets: false, greeting: null };
}

/**
 * Writes part of a card's layout entry back, creating it if needed.
 * @param {Layout} layout
 * @param {string} avatar
 * @param {Partial<LayoutEntry>} patch
 */
function setLayoutEntry(layout, avatar, patch) {
    const entry = Object.assign(getLayoutEntry(layout, avatar), patch);

    // Speaking, and which greeting to speak, only mean anything for a card that
    // is in the scene at all.
    if (!entry.active) {
        entry.greets = false;
        entry.greeting = null;
    }

    layout.cards[avatar] = entry;
    saveSettingsDebounced();
}

/**
 * The greetings a card can open a group scene with.
 *
 * Deliberately only the group-only pool, never first_mes or the ordinary
 * alternate greetings: pinning a scene's opening line is a promise about what
 * appears, and the ordinary greetings are written for a solo chat. A card with
 * no group greetings simply can't be pinned, and falls through to whatever ST
 * would have done.
 *
 * Precedence matches Extension-GroupGreetings' own reader so both agree on
 * which list is in play: Spec v3 group_only_greetings, with the legacy
 * extensions.group_greetings used only when v3 is present but empty.
 * @param {object} [character]
 * @returns {string[]}
 */
function getGroupGreetings(character) {
    const clean = (list) => list.filter(x => typeof x === 'string' && x.trim().length);
    const specV3 = character?.data?.group_only_greetings;
    const legacy = character?.data?.extensions?.group_greetings;

    if (Array.isArray(specV3) && Array.isArray(legacy) && legacy.length && !specV3.length) {
        return clean(legacy);
    }
    if (Array.isArray(specV3)) {
        return clean(specV3);
    }
    if (Array.isArray(legacy)) {
        return clean(legacy);
    }
    return [];
}

/**
 * Drops rosters whose group is gone. There is no group-deleted event — only
 * GROUP_CHAT_DELETED — so this sweeps once the group list is known rather than
 * reacting to the deletion itself. Bails while the list is empty, since that is
 * indistinguishable from it not having loaded yet.
 */
function pruneOrphanRosters() {
    if (!groups.length) {
        return;
    }

    const settings = getSettings();
    let dirty = false;

    for (const id of Object.keys(settings.groups)) {
        if (!groups.some(x => x.id === id)) {
            delete settings.groups[id];
            dirty = true;
        }
    }

    if (dirty) {
        saveSettingsDebounced();
    }
}

/** @returns {object|null} The currently open group, or null if not in a group chat. */
function getCurrentGroup() {
    if (!selected_group) {
        return null;
    }
    return groups.find(x => x.id === selected_group) ?? null;
}

/** @returns {object|undefined} Character object for an avatar file name. */
function getCharacterByAvatar(avatar) {
    return characters.find(x => x.avatar === avatar);
}

// #region Group actions

/**
 * Re-renders the Group Control panel's member and candidate lists.
 * editGroup() only persists the roster; the two lists are painted by
 * printGroupMembers()/printGroupCandidates(), which aren't exported, so they
 * stay stale until the group card is reselected. select_group_chats() calls
 * both. skipAnimation = true so it repaints in place without yanking the
 * right-hand menu open.
 */
function refreshGroupControlPanel() {
    // menu_type is already 'group_edit' here, so select_group_chats() calling
    // setMenuType('group_edit') is a no-op and carries no side effect. No
    // :visible test: jQuery reports the block as hidden whenever the right-nav
    // drawer is collapsed, and nothing repaints it on reopen, which left the
    // member list stale exactly when the panel was closed mid-edit.
    if (menu_type !== 'group_edit' || openGroupId !== selected_group) {
        return;
    }

    select_group_chats(selected_group, true);
}

/**
 * Adds or removes a character from the currently open group chat.
 * @param {string} avatar Avatar file name of the character
 * @param {boolean} shouldBeMember Target state: true = in the group, false = out
 * @returns {Promise<boolean>} Whether the group was actually changed
 */
async function setMembership(avatar, shouldBeMember) {
    const group = getCurrentGroup();

    if (!group || !Array.isArray(group.members)) {
        toastr.warning(t`Open a group chat first.`);
        return false;
    }

    if (!getCharacterByAvatar(avatar)) {
        toastr.error(t`Character not found: ${avatar}`);
        return false;
    }

    const index = group.members.indexOf(avatar);

    if (shouldBeMember) {
        if (index !== -1) {
            return false;
        }
        group.members.push(avatar);
    } else {
        if (index === -1) {
            return false;
        }
        group.members.splice(index, 1);
        // Don't leave a stale mute behind for a character that is no longer a member
        if (Array.isArray(group.disabled_members)) {
            const disabledIndex = group.disabled_members.indexOf(avatar);
            if (disabledIndex !== -1) {
                group.disabled_members.splice(disabledIndex, 1);
            }
        }
    }

    // immediately = true so the member list is on disk before anything can generate,
    // reload = false so the character list / group panel isn't torn down under us.
    await editGroup(selected_group, true, false);
    refreshGroupControlPanel();
    await eventSource.emit(event_types.GROUP_UPDATED);
    return true;
}

/**
 * Makes a specific group member take the next turn, bypassing the activation strategy.
 * @param {string} avatar Avatar file name of the character
 * @returns {Promise<void>}
 */
async function forceTurn(avatar) {
    const group = getCurrentGroup();

    if (!group || !Array.isArray(group.members)) {
        toastr.warning(t`Open a group chat first.`);
        return;
    }

    if (!group.members.includes(avatar)) {
        toastr.warning(t`${getCharacterByAvatar(avatar)?.name ?? avatar} is not a member of this group.`);
        return;
    }

    const chid = characters.findIndex(x => x.avatar === avatar);

    if (chid === -1) {
        toastr.error(t`Character not found: ${avatar}`);
        return;
    }

    try {
        await waitUntilCondition(() => !isGenerating(), 10000, 100);
    } catch {
        toastr.warning(t`Cannot force a turn while a reply is being generated.`);
        return;
    }

    // Anything typed in the box is posted as its own user turn first, so the
    // forced reply answers it instead of it being thrown away. Generate() would
    // otherwise swallow the box as a user message attached to the forced turn.
    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    if (String(textarea?.value ?? '').trim()) {
        await sendUserTurnOnly();
    } else if (textarea?.value) {
        // Whitespace only: nothing worth posting, but still clear it.
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await unshallowGroupMembers(selected_group);
    await Generate('normal', { force_chid: chid });
}

/**
 * Reads the chat-scoped Author's Note.
 * @returns {string}
 */
function getChatAuthorsNote() {
    return String($('#extension_floating_prompt').val() ?? '');
}

/**
 * Writes the chat-scoped Author's Note.
 * Goes through the textarea and an input event rather than poking
 * chat_metadata directly, so the Author's Note extension's own handler runs:
 * it persists the value, refreshes the token counter and updates settings.
 * @param {string} text
 * @returns {boolean} Whether the field was found
 */
function setChatAuthorsNote(text) {
    const field = /** @type {HTMLTextAreaElement} */ (document.getElementById('extension_floating_prompt'));

    if (!field) {
        toastr.error(t`Author's Note field not found.`);
        return false;
    }

    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

/**
 * The note the footer toggle applies: the selected layout's, falling back to
 * the group's. A layout's note is an override for one scene, so a blank one
 * means "use the group's" rather than "no note".
 * @returns {string}
 */
function getEffectiveNote() {
    const roster = getActiveRoster();
    return getActiveLayout(roster)?.note || roster?.note || '';
}

/**
 * Whether the note for the open group and layout is currently the chat's
 * Author's Note. Derived from the live field rather than stored, so the toggle
 * still tells the truth after the note is edited by hand or the chat is
 * switched.
 * @returns {boolean}
 */
function isNoteApplied() {
    const note = getEffectiveNote();
    return Boolean(note) && getChatAuthorsNote() === note;
}

/**
 * Applies the active roster's Author's Note to the current chat, or clears the
 * chat's note when switched off.
 * @param {boolean} shouldApply
 */
/**
 * Pins the viewer to one character, or hands it back to the last speaker.
 * @param {string|null} avatar
 */
function setFocusedAvatar(avatar) {
    focusedAvatar = avatar;
    refreshPanel();
    refocusViewer();
}

function setNoteApplied(shouldApply) {
    const note = getEffectiveNote();

    if (shouldApply && !note) {
        toastr.info(t`This group has no Author's Note. Set one in Extensions → SideStage.`);
        return;
    }

    setChatAuthorsNote(shouldApply ? note : '');
    refreshPanel();
}

/**
 * Posts whatever is in the message box as a user turn and stops there.
 * sendMessageAsUser() appends, renders, saves and emits on its own; not
 * calling Generate() afterwards is what keeps any character from replying.
 * forceTurn() runs this first when the box has text, then generates.
 * @returns {Promise<void>}
 */
async function sendUserTurnOnly() {
    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    const text = String(textarea?.value ?? '').trim();

    if (!text) {
        toastr.info(t`Type a message first.`);
        return;
    }

    try {
        await waitUntilCondition(() => !isGenerating(), 10000, 100);
    } catch {
        toastr.warning(t`Cannot send while a reply is being generated.`);
        return;
    }

    // Bias must be extracted before the text is consumed, same as /send does.
    const bias = extractMessageBias(text);

    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    await sendMessageAsUser(text, bias);
}

// #endregion

// #region Roster panel

function isPanelOpen() {
    return $(`#${PANEL_ID}`).length > 0;
}

function closePanel() {
    const $win = $(`#${PANEL_ID}`);

    if (!$win.length) {
        return;
    }

    $win.remove();
}

/**
 * Builds one compact card row: avatar, name, and the two inline icon toggles.
 * @param {string} avatar Avatar file name
 * @returns {HTMLElement}
 */
function makeCardRow(avatar) {
    const character = getCharacterByAvatar(avatar);
    const group = getCurrentGroup();
    const isMember = Boolean(group?.members?.includes(avatar));

    const row = document.createElement('div');
    row.classList.add('gr-card');
    row.dataset.avatar = avatar;

    const thumb = document.createElement('img');
    thumb.classList.add('gr-card-avatar');
    thumb.src = getThumbnailUrl('avatar', avatar);
    thumb.alt = character?.name ?? avatar;
    row.appendChild(thumb);

    const name = document.createElement('div');
    name.classList.add('gr-card-name');
    name.textContent = character?.name ?? avatar;
    name.title = character?.name ?? avatar;
    if (!character) {
        name.classList.add('gr-card-missing');
        name.title = t`Character file not found`;
    }
    row.appendChild(name);

    // Clicking the card pins the viewer to this character; clicking it again
    // hands the viewer back to whoever spoke last. Bound to the avatar and the
    // name rather than to the row, so it cannot fight the icon toggles' labels.
    if (character) {
        const isFocused = focusedAvatar === avatar;
        row.classList.toggle('gr-focused', isFocused);
        const focus = () => setFocusedAvatar(isFocused ? null : avatar);

        for (const element of [thumb, name]) {
            element.classList.add('gr-focusable');
            element.title = isFocused
                ? t`Showing only this character's images — click to follow the last speaker again`
                : t`Show only this character's images`;
            element.addEventListener('click', focus);
        }

        name.tabIndex = 0;
        name.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                focus();
            }
        });
    }

    /**
     * Builds a hidden-checkbox icon toggle that sits inline on the row.
     * @param {string} className Modifier class
     * @param {string} icon Font Awesome icon class
     * @param {string} title Tooltip
     * @returns {{label: HTMLLabelElement, input: HTMLInputElement}}
     */
    function makeIconToggle(className, icon, title) {
        const label = document.createElement('label');
        label.classList.add('gr-icon-toggle', className);
        label.title = title;
        const input = document.createElement('input');
        input.type = 'checkbox';
        const glyph = document.createElement('i');
        glyph.classList.add('fa-solid', icon);
        label.append(input, glyph);
        return { label, input };
    }

    // Toggle 1: membership in the current group
    const member = makeIconToggle('gr-member', 'fa-user-check', t`Add to / remove from the current group chat`);
    member.input.checked = isMember;
    member.input.disabled = !group || !character;
    member.input.addEventListener('change', async () => {
        const wanted = member.input.checked;
        member.input.disabled = true;
        try {
            const changed = await setMembership(avatar, wanted);
            if (!changed) {
                member.input.checked = !wanted;
            }
        } finally {
            member.input.disabled = false;
            refreshPanel();
        }
    });
    row.appendChild(member.label);

    // Toggle 2: force a turn (self-resets once generation finishes)
    const turn = makeIconToggle('gr-turn', 'fa-comment-dots', t`Make this character speak next`);
    turn.input.disabled = !isMember;
    turn.input.addEventListener('change', async () => {
        if (!turn.input.checked) {
            return;
        }
        row.classList.add('gr-speaking');
        try {
            await forceTurn(avatar);
        } catch (error) {
            console.error('[Group Roster] Failed to force a turn', error);
            toastr.error(error?.message || t`Unknown error`, t`Failed to force a turn`);
        } finally {
            row.classList.remove('gr-speaking');
            turn.input.checked = false;
        }
    });
    row.appendChild(turn.label);

    return row;
}

/**
 * Switches the open group's layout and brings every view of it back in step.
 * Shared by the panel footer's picker and the settings drawer's.
 * @param {string} id
 */
function setActiveLayout(id) {
    const roster = getActiveRoster();

    if (!roster) {
        return;
    }

    roster.activeLayoutId = String(id);
    saveSettingsDebounced();
    renderSettings();
    refreshPanel();
}

/**
 * Repaints the footer's layout picker, but only when the list itself changed:
 * refreshPanel() runs on every generation event, and rebuilding the options
 * each time would shut the dropdown under the user mid-choice. The group is
 * part of the signature so two groups with same-named layouts still swap.
 */
function refreshLayoutPicker() {
    const picker = /** @type {HTMLSelectElement} */ (document.getElementById('groupRosterLayoutPicker'));

    if (!picker) {
        return;
    }

    const roster = getActiveRoster();
    const layouts = roster?.layouts ?? [];
    const signature = [getCurrentGroup()?.id ?? '', ...layouts.map(x => `${x.id}:${x.name}`)].join('\u0000');

    if (picker.dataset.signature !== signature) {
        picker.dataset.signature = signature;
        picker.innerHTML = '';

        const none = document.createElement('option');
        none.value = '';
        none.textContent = t`No layout`;
        picker.appendChild(none);

        for (const layout of layouts) {
            const option = document.createElement('option');
            option.value = layout.id;
            option.textContent = layout.name;
            picker.appendChild(option);
        }
    }

    picker.value = roster?.activeLayoutId ?? '';
    picker.disabled = !roster;
}

/** Re-renders the card list inside an already open panel. */
function refreshPanel() {
    const list = document.getElementById('groupRosterList');
    if (!list) {
        return;
    }

    const cards = getActiveCards();
    list.innerHTML = '';

    const status = document.getElementById('groupRosterStatus');
    if (status) {
        const group = getCurrentGroup();
        status.textContent = group ? group.name : t`No group chat open`;
        status.classList.toggle('gr-warning', !group);
    }

    const noteToggle = /** @type {HTMLInputElement} */ (document.querySelector('#groupRosterNoteToggle input'));
    if (noteToggle) {
        noteToggle.checked = isNoteApplied();
        noteToggle.disabled = !getEffectiveNote();
    }

    refreshLayoutPicker();

    if (!cards.length) {
        const empty = document.createElement('div');
        empty.classList.add('gr-empty');
        empty.textContent = t`No cards in this group's roster. Add them in Extensions → SideStage.`;
        list.appendChild(empty);
        return;
    }

    for (const avatar of cards) {
        list.appendChild(makeCardRow(avatar));
    }
}

/** Creates the draggable panel — same template, size and container as the Gallery. */
/**
 * Creates the floating roster window.
 * Deliberately avoids ST's built-in draggable stack, which inherits the core
 * `.draggable` rule that forces 100vw/100vh below 1000px and eats the whole
 * screen on a tablet. This mirrors the Character Image Viewer's own window
 * instead: position fixed, jQuery UI drag/resize, identical spawn box.
 */
function openPanel() {
    if (isPanelOpen()) {
        closePanel();
        return;
    }

    const html = `
        <div id="${PANEL_ID}" class="gr-window ss-dock">
            <div class="gr-header">
                <span class="gr-title">${t`SideStage`}<small id="groupRosterStatus" class="gr-status"></small></span>
            </div>
            <div class="gr-body">
                <div id="groupRosterList" class="gr-grid"></div>
            </div>
            <div class="gr-footer">
                <label id="groupRosterNoteToggle" class="gr-footer-btn gr-footer-toggle"
                       title="${t`Fill this chat's Author's Note with this group's note`}">
                    <input type="checkbox">
                    <i class="fa-solid fa-note-sticky fa-fw"></i>
                    <span>${t`Author's Note`}</span>
                </label>
                <select id="groupRosterLayoutPicker" class="gr-footer-select"
                        title="${t`Greeting layout used when this group starts a new chat`}"></select>
            </div>
        </div>`;

    $('body').append(html);
    const $win = $(`#${PANEL_ID}`);

    $win.find('#groupRosterNoteToggle input').on('change', function () {
        setNoteApplied(this.checked);
    });

    $win.find('#groupRosterLayoutPicker').on('change', function () {
        setActiveLayout(String($(this).val()));
    });

    refreshPanel();
}

// #endregion

// #region Settings UI

const settingsHtml = `
<div class="sidestage-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>SideStage</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="ss-settings-section">
                <div class="ss-settings-heading">Roster</div>
                <label for="gr_group_select">Group</label>
                <select id="gr_group_select" class="text_pole"></select>
                <div id="gr_legacy_block">
                    <label for="gr_legacy_select">Leftover rosters (from before rosters followed groups)</label>
                    <div class="flex-container alignItemsCenter">
                        <select id="gr_legacy_select" class="text_pole flex1"></select>
                        <div id="gr_legacy_import" class="menu_button interactable gr-flat-button" title="Add this roster's cards to the group above">Import</div>
                        <div id="gr_legacy_discard" class="menu_button menu_button_icon interactable" title="Discard every leftover roster">
                            <i class="fa-solid fa-trash fa-fw"></i>
                        </div>
                    </div>
                </div>
                <label for="gr_roster_note">Author's Note for this group</label>
                <textarea id="gr_roster_note" class="text_pole textarea_compact" rows="3"
                          placeholder="Filled into this chat's Author's Note when the panel toggle is on"></textarea>
                <div class="gr-lists">
                    <div class="gr-list-pane">
                        <div class="gr-list-title">In roster (<span id="gr_in_count">0</span>)</div>
                        <div id="gr_in_list" class="gr-settings-list"></div>
                        <div class="flex-container">
                            <div id="gr_settings_clear" class="menu_button interactable gr-flat-button" title="Remove every character from this roster">Clear</div>
                        </div>
                    </div>
                    <div class="gr-list-pane">
                        <div class="gr-list-title">Available characters</div>
                        <input id="gr_settings_search" type="search" class="text_pole" placeholder="Search characters...">
                        <div id="gr_out_list" class="gr-settings-list"></div>
                    </div>
                </div>
            </div>

            <div class="ss-settings-divider"></div>

            <div class="ss-settings-section">
                <div class="ss-settings-heading">Greeting layouts</div>
                <label for="gr_layout_select">Layout for this group</label>
                <div class="flex-container alignItemsCenter">
                    <select id="gr_layout_select" class="text_pole flex1"></select>
                    <div id="gr_layout_new" class="menu_button menu_button_icon interactable" title="New layout">
                        <i class="fa-solid fa-plus fa-fw"></i>
                    </div>
                    <div id="gr_layout_rename" class="menu_button menu_button_icon interactable" title="Rename layout">
                        <i class="fa-solid fa-pen fa-fw"></i>
                    </div>
                    <div id="gr_layout_delete" class="menu_button menu_button_icon interactable" title="Delete layout">
                        <i class="fa-solid fa-trash fa-fw"></i>
                    </div>
                </div>
                <div id="gr_layout_body">
                    <label for="gr_layout_note">Author's Note for this layout</label>
                    <textarea id="gr_layout_note" class="text_pole textarea_compact" rows="3"
                              placeholder="Overrides the group's note while this layout is selected"></textarea>
                    <div id="gr_layout_cards" class="gr-layout-grid"></div>
                </div>
            </div>

            <div class="ss-settings-divider"></div>

            <div class="ss-settings-section">
                <div class="ss-settings-heading">Images</div>
                <div class="ss-settings-toggles">
                    <label class="checkbox_label" for="civ-auto-open" title="Opens the floating viewer whenever a character or group with images is selected. With this off there is no way to open the viewer, since the gallery is reached from it.">
                        <input id="civ-auto-open" type="checkbox">
                        <span>Open automatically</span>
                    </label>
                    <label class="checkbox_label" for="civ-change-with-greeting" title="Opens on the image referenced by the greeting on screen, and switches when you swipe to an alternate greeting. With this off the viewer opens on the first image found and stays put until you navigate it yourself.">
                        <input id="civ-change-with-greeting" type="checkbox">
                        <span>Change with greeting</span>
                    </label>
                </div>
            </div>
        </div>
    </div>
</div>`;

/** Fills the group dropdown, which is what picks the roster being edited. */
function renderGroupSelect() {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('gr_group_select'));

    if (!select) {
        return;
    }

    select.innerHTML = '';
    select.disabled = !groups.length;

    if (!groups.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = t`No group chats yet`;
        select.appendChild(option);
        return;
    }

    for (const group of groups) {
        const option = document.createElement('option');
        option.value = group.id;
        // create: false so merely listing the groups doesn't seed a roster for
        // every one of them; the count falls back to the cast it would seed from.
        const count = getRoster(group.id, { create: false })?.cards.length ?? group.members?.length ?? 0;
        option.textContent = `${group.name} (${count})`;
        select.appendChild(option);
    }

    select.value = getSettingsGroupId();
}

/**
 * Shows the leftover-roster import row, and hides it for good once there is
 * nothing left to import.
 */
function renderLegacyImport() {
    const settings = getSettings();
    const block = document.getElementById('gr_legacy_block');
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('gr_legacy_select'));

    if (!block || !select) {
        return;
    }

    block.style.display = settings.legacyRosters.length ? '' : 'none';
    select.innerHTML = '';

    for (const roster of settings.legacyRosters) {
        const option = document.createElement('option');
        option.value = roster.id;
        option.textContent = `${roster.name} (${roster.cards.length})`;
        select.appendChild(option);
    }
}

/** @returns {Layout|null} The layout the settings drawer edits. */
function getSettingsLayout() {
    return getActiveLayout(getSettingsRoster());
}

/** True while roster cards are being loaded, so the repaint can't loop. */
let loadingCardData = false;

/**
 * Roster cards that aren't group members are shallow, and a shallow card has no
 * data.group_only_greetings to list — the greeting column would read as "no
 * group greetings" for every card on the bench. Loads them once and repaints.
 * @param {Roster|null} roster
 */
function ensureGreetingsLoaded(roster) {
    if (loadingCardData || !roster) {
        return;
    }

    const pending = roster.cards
        .map(avatar => characters.findIndex(x => x.avatar === avatar))
        .filter(chid => chid !== -1 && characters[chid]?.shallow);

    if (!pending.length) {
        return;
    }

    loadingCardData = true;

    (async () => {
        try {
            for (const chid of pending) {
                await unshallowCharacter(chid);
            }
        } catch (error) {
            console.error('[SideStage] Could not load card data for the layout editor', error);
        } finally {
            loadingCardData = false;
            renderLayoutCards();
        }
    })();
}

/** Fills the layout dropdown for whichever group the drawer is showing. */
function renderLayoutSelect() {
    const roster = getSettingsRoster();
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('gr_layout_select'));

    if (!select) {
        return;
    }

    select.innerHTML = '';
    select.disabled = !roster;

    // Always offered: a group with no layout selected is left entirely alone,
    // which is the only way back to stock behaviour once layouts exist.
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t`No layout`;
    select.appendChild(none);

    for (const layout of roster?.layouts ?? []) {
        const option = document.createElement('option');
        option.value = layout.id;
        option.textContent = layout.name;
        select.appendChild(option);
    }

    select.value = roster?.activeLayoutId ?? '';
    $('#gr_layout_new').toggleClass('disabled', !roster);
    $('#gr_layout_rename').toggleClass('disabled', !getSettingsLayout());
    $('#gr_layout_delete').toggleClass('disabled', !getSettingsLayout());
}

/**
 * Builds one checkbox cell of the layout matrix.
 * @param {{checked: boolean, disabled: boolean, title: string, onChange: function(boolean): void}} options
 * @returns {HTMLLabelElement}
 */
function makeLayoutCheckbox({ checked, disabled, title, onChange }) {
    const cell = document.createElement('label');
    cell.classList.add('gr-layout-check');
    cell.title = title;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', () => onChange(input.checked));

    cell.appendChild(input);
    return cell;
}

/**
 * Builds the greeting picker for one card. Only group greetings are offered;
 * a card without any can still greet, just not from a pinned line.
 * @param {Layout} layout
 * @param {string} avatar
 * @param {object} [character]
 * @param {LayoutEntry} entry
 * @returns {HTMLSelectElement}
 */
function makeGreetingSelect(layout, avatar, character, entry) {
    const select = document.createElement('select');
    select.classList.add('text_pole', 'gr-layout-greeting');
    const greetings = getGroupGreetings(character);

    if (!greetings.length) {
        const option = document.createElement('option');
        option.textContent = t`No group greetings`;
        select.appendChild(option);
        select.disabled = true;
        select.title = t`Only group greetings can be pinned. Add some from the button beside Alt. Greetings on the card.`;
        return select;
    }

    const random = document.createElement('option');
    random.value = '';
    random.textContent = t`Random`;
    select.appendChild(random);

    greetings.forEach((text, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        const summary = text.replace(/\s+/g, ' ').trim();
        option.textContent = `${index + 1}. ${summary.length > 60 ? `${summary.slice(0, 60)}…` : summary}`;
        option.title = text;
        select.appendChild(option);
    });

    // A pin past the end of an edited card's list reads as random rather than
    // silently becoming whichever greeting slid into that index.
    const pinned = Number.isInteger(entry.greeting) && entry.greeting < greetings.length ? entry.greeting : null;
    select.value = pinned === null ? '' : String(pinned);
    select.disabled = !entry.greets;
    select.title = t`Which group greeting this card opens with`;

    select.addEventListener('change', () => {
        setLayoutEntry(layout, avatar, { greeting: select.value === '' ? null : Number(select.value) });
    });

    return select;
}

/**
 * Appends one card's cells to the matrix. The cells are appended flat rather
 * than wrapped in a row, so every column lines up across cards of any width.
 * @param {HTMLElement} container
 * @param {Layout} layout
 * @param {string} avatar
 */
function appendLayoutRow(container, layout, avatar) {
    const character = getCharacterByAvatar(avatar);
    const entry = getLayoutEntry(layout, avatar);

    const thumb = document.createElement('img');
    thumb.classList.add('gr-settings-avatar');
    thumb.src = getThumbnailUrl('avatar', avatar);
    thumb.alt = character?.name ?? avatar;

    const name = document.createElement('span');
    name.classList.add('gr-settings-name');
    name.textContent = character?.name ?? avatar;

    if (!character) {
        name.classList.add('gr-card-missing');
        name.title = t`Character file not found`;
    }

    const active = makeLayoutCheckbox({
        checked: entry.active,
        disabled: !character,
        title: t`In the group while this layout is selected`,
        onChange: (checked) => {
            // Being in the scene implies opening it; uncheck Greets to have a
            // card present from the start without a line of its own.
            setLayoutEntry(layout, avatar, { active: checked, greets: checked });
            renderLayoutCards();
        },
    });

    const greets = makeLayoutCheckbox({
        checked: entry.greets,
        disabled: !character || !entry.active,
        title: t`Posts an opening message when a new chat starts`,
        onChange: (checked) => {
            setLayoutEntry(layout, avatar, { greets: checked });
            renderLayoutCards();
        },
    });

    container.append(thumb, name, active, greets, makeGreetingSelect(layout, avatar, character, entry));
}

/** Paints the matrix: who is in the scene, who opens it, and with what. */
function renderLayoutCards() {
    const body = document.getElementById('gr_layout_body');
    const container = document.getElementById('gr_layout_cards');

    if (!body || !container) {
        return;
    }

    const roster = getSettingsRoster();
    const layout = getSettingsLayout();

    body.style.display = layout ? '' : 'none';

    if (!layout) {
        return;
    }

    ensureGreetingsLoaded(roster);
    container.innerHTML = '';

    if (!roster.cards.length) {
        const empty = document.createElement('div');
        empty.classList.add('gr-empty', 'gr-layout-span');
        empty.textContent = t`This group's roster is empty — add cards above.`;
        container.appendChild(empty);
        return;
    }

    for (const label of ['', t`Card`, t`In scene`, t`Greets`, t`Greeting`]) {
        const cell = document.createElement('div');
        cell.classList.add('gr-layout-head');
        cell.textContent = label;
        container.appendChild(cell);
    }

    for (const avatar of roster.cards) {
        appendLayoutRow(container, layout, avatar);
    }
}

/**
 * Builds one row for either settings list.
 * @param {object} character Character object
 * @param {boolean} isMember Whether the character is in the active roster
 * @returns {HTMLElement}
 */
function makeSettingsRow(character, isMember) {
    const row = document.createElement('div');
    row.classList.add('gr-settings-row');
    row.tabIndex = 0;
    row.title = isMember ? t`Remove from roster` : t`Add to roster`;

    const thumb = document.createElement('img');
    thumb.classList.add('gr-settings-avatar');
    thumb.src = getThumbnailUrl('avatar', character.avatar);
    thumb.alt = character.name;

    const name = document.createElement('span');
    name.classList.add('gr-settings-name');
    name.textContent = character.name;

    const action = document.createElement('i');
    action.classList.add('fa-solid', 'fa-fw', isMember ? 'fa-minus' : 'fa-plus', 'gr-settings-action');

    row.append(thumb, name, action);

    const toggle = () => {
        const roster = getSettingsRoster();

        if (!roster) {
            return;
        }

        const index = roster.cards.indexOf(character.avatar);

        if (isMember && index !== -1) {
            roster.cards.splice(index, 1);
        } else if (!isMember && index === -1) {
            roster.cards.push(character.avatar);
        }

        saveSettingsDebounced();
        renderGroupSelect();
        renderRosterLists();
        renderLayoutCards();
        refreshPanel();
    };

    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
        }
    });

    return row;
}

/** Renders both settings lists: the active roster, and everything not in it. */
function renderRosterLists() {
    const inList = document.getElementById('gr_in_list');
    const outList = document.getElementById('gr_out_list');

    if (!inList || !outList) {
        return;
    }

    const roster = getSettingsRoster();
    const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('gr_settings_search'));
    const term = (searchInput?.value ?? '').trim().toLowerCase();

    inList.innerHTML = '';
    outList.innerHTML = '';

    const inCount = document.getElementById('gr_in_count');
    if (inCount) {
        inCount.textContent = String(roster?.cards.length ?? 0);
    }

    if (!roster) {
        const empty = document.createElement('div');
        empty.classList.add('gr-empty');
        empty.textContent = t`Create a group chat first — rosters belong to a group.`;
        inList.appendChild(empty);
        return;
    }

    // Roster order is meaningful, so walk cards rather than the character list.
    for (const avatar of roster.cards) {
        const character = getCharacterByAvatar(avatar);

        if (!character) {
            const missing = document.createElement('div');
            missing.classList.add('gr-settings-row', 'gr-card-missing');
            missing.textContent = t`Missing: ${avatar}`;
            inList.appendChild(missing);
            continue;
        }

        inList.appendChild(makeSettingsRow(character, true));
    }

    if (!roster.cards.length) {
        const empty = document.createElement('div');
        empty.classList.add('gr-empty');
        empty.textContent = t`Empty roster.`;
        inList.appendChild(empty);
    }

    const available = characters
        .filter(x => !roster.cards.includes(x.avatar))
        .filter(x => !term || x.name.toLowerCase().includes(term))
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const character of available) {
        outList.appendChild(makeSettingsRow(character, false));
    }

    if (!available.length) {
        const empty = document.createElement('div');
        empty.classList.add('gr-empty');
        empty.textContent = term ? t`No characters match.` : t`Every character is in this roster.`;
        outList.appendChild(empty);
    }
}

function renderSettings() {
    renderGroupSelect();
    renderLegacyImport();
    renderRosterLists();
    renderLayoutSelect();
    renderLayoutCards();
    $('#gr_roster_note').val(getSettingsRoster()?.note ?? '').prop('disabled', !getSettingsRoster());
    $('#gr_layout_note').val(getSettingsLayout()?.note ?? '');
}

function addSettings() {
    $('#extensions_settings2').append(settingsHtml);

    $('#gr_group_select').on('change', function () {
        settingsGroupId = String($(this).val());
        renderSettings();
    });

    $('#gr_legacy_import').on('click', () => {
        const roster = getSettingsRoster();

        if (!roster) {
            toastr.warning(t`Create a group chat first.`);
            return;
        }

        const legacy = getSettings().legacyRosters.find(x => x.id === String($('#gr_legacy_select').val()));

        if (!legacy) {
            return;
        }

        // Union rather than replace: importing twice, or importing two
        // overlapping rosters, must not duplicate a card.
        const added = legacy.cards.filter(x => !roster.cards.includes(x));
        roster.cards.push(...added);
        saveSettingsDebounced();
        renderSettings();
        refreshPanel();
        toastr.info(added.length
            ? t`Added ${added.length} card(s) to this group's roster.`
            : t`Every card was already in this group's roster.`);
    });

    $('#gr_legacy_discard').on('click', async () => {
        const confirmed = await Popup.show.confirm(
            t`Discard leftover rosters`,
            t`Delete every roster left over from before rosters followed groups? Group rosters are not touched.`);

        if (!confirmed) {
            return;
        }

        getSettings().legacyRosters = [];
        saveSettingsDebounced();
        renderSettings();
    });

    $('#gr_roster_note').on('input', function () {
        const roster = getSettingsRoster();

        if (!roster) {
            return;
        }

        roster.note = String($(this).val());
        saveSettingsDebounced();
        // The footer toggle greys out for a group with no note, and its checked
        // state compares against this text.
        refreshPanel();
    });

    $('#gr_layout_select').on('change', function () {
        const roster = getSettingsRoster();

        if (!roster) {
            return;
        }

        roster.activeLayoutId = String($(this).val());
        saveSettingsDebounced();
        renderSettings();
        refreshPanel();
    });

    $('#gr_layout_new').on('click', async () => {
        const roster = getSettingsRoster();

        if (!roster) {
            toastr.warning(t`Create a group chat first.`);
            return;
        }

        const name = await Popup.show.input(t`New layout`, t`Name for the new layout`, '');

        if (!name) {
            return;
        }

        /** @type {Layout} */
        const layout = { id: uuidv4(), name: String(name).trim(), note: '', cards: {} };

        // Seeded from the cast the group has right now, so a new layout starts
        // out doing what the group already does and is edited down from there.
        const group = groups.find(x => x.id === getSettingsGroupId());

        for (const avatar of roster.cards) {
            if (group?.members?.includes(avatar)) {
                layout.cards[avatar] = { active: true, greets: true, greeting: null };
            }
        }

        roster.layouts.push(layout);
        roster.activeLayoutId = layout.id;
        saveSettingsDebounced();
        renderSettings();
        refreshPanel();
    });

    $('#gr_layout_rename').on('click', async () => {
        const layout = getSettingsLayout();

        if (!layout) {
            return;
        }

        const name = await Popup.show.input(t`Rename layout`, t`New name`, layout.name);

        if (!name) {
            return;
        }

        layout.name = String(name).trim();
        saveSettingsDebounced();
        renderLayoutSelect();
        refreshPanel();
    });

    $('#gr_layout_delete').on('click', async () => {
        const roster = getSettingsRoster();
        const layout = getSettingsLayout();

        if (!roster || !layout) {
            return;
        }

        const confirmed = await Popup.show.confirm(t`Delete layout`, t`Delete "${layout.name}"?`);

        if (!confirmed) {
            return;
        }

        roster.layouts = roster.layouts.filter(x => x.id !== layout.id);
        roster.activeLayoutId = '';
        saveSettingsDebounced();
        renderSettings();
        refreshPanel();
    });

    $('#gr_layout_note').on('input', function () {
        const layout = getSettingsLayout();

        if (!layout) {
            return;
        }

        layout.note = String($(this).val());
        saveSettingsDebounced();
        // The footer toggle prefers this note over the group's, and its checked
        // state compares against whichever is in play.
        refreshPanel();
    });

    $('#gr_settings_search').on('input', renderRosterLists);

    $('#gr_settings_clear').on('click', () => {
        const roster = getSettingsRoster();

        if (!roster) {
            return;
        }

        roster.cards = [];
        saveSettingsDebounced();
        renderSettings();
        refreshPanel();
    });

    // Characters may still be loading when the drawer is built, so repaint the
    // lists whenever it is opened rather than trusting the one-shot render.
    $(document).on('click', '.sidestage-settings .inline-drawer-toggle', renderSettings);

    // Image half of the same drawer.
    $('#civ-auto-open')
        .prop('checked', !!imageSettings.autoOpen)
        .on('change', function () {
            imageSettings.autoOpen = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#civ-change-with-greeting')
        .prop('checked', !!imageSettings.changeWithGreeting)
        .on('change', function () {
            imageSettings.changeWithGreeting = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    renderSettings();
}

// #endregion

/**
 * Opens the roster when a group chat is selected and closes it otherwise, so
 * the window follows the chat rather than lingering over a solo character.
 * The wand button still toggles it by hand within a group.
 */
function syncPanelToChat() {
    focusedAvatar = null;
    // Hand the drawer back to the open group; a hand-picked group only outlives
    // the chat it was picked during if the user picks it again.
    settingsGroupId = '';

    if ($('.sidestage-settings .inline-drawer-content').is(':visible')) {
        renderSettings();
    }

    if (!selected_group) {
        closePanel();
        return;
    }

    if (isPanelOpen()) {
        refreshPanel();
        return;
    }

    openPanel();
}

function addWandButton() {
    const container = document.getElementById('sidestage_wand_container') ?? document.getElementById('extensionsMenu');
    if (!container) {
        return;
    }

    const button = document.createElement('div');
    button.id = 'sidestage_wand';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    button.tabIndex = 0;
    button.title = t`Open the SideStage roster`;

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-masks-theater', 'extensionsMenuExtensionButton');

    const label = document.createElement('span');
    label.textContent = t`SideStage`;

    button.append(icon, label);
    button.addEventListener('click', openPanel);
    container.appendChild(button);
}

// ════════════════════ Character images ══════════════════════

const extensionName = "CharImgViewer";
const settingsKey = "charImgViewer";
const logPrefix = `[${extensionName}]`;

console.log(logPrefix, "Loading v1.5.0...");

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
const imageDefaults = Object.freeze({
  autoOpen: true,
  changeWithGreeting: true,
});
let imageSettings = Object.assign({}, imageDefaults);

function loadImageSettings(ctx) {
  if (!ctx || !ctx.extensionSettings) return;
  ctx.extensionSettings[settingsKey] = Object.assign(
    {},
    imageDefaults,
    ctx.extensionSettings[settingsKey],
  );
  imageSettings = ctx.extensionSettings[settingsKey];
}

// --- 3. ACTIVE CHARACTER RESOLUTION ---
function findGroup(ctx) {
  if (!ctx || !ctx.groupId) return null;
  return (ctx.groups || []).find((g) => String(g.id) === String(ctx.groupId)) ?? null;
}

// Whoever last took a turn, ignoring the user's own messages and system ones.
function getLastSpeakerAvatar(ctx) {
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];

  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i];
    if (!message || message.is_user || message.is_system) continue;
    if (message.original_avatar) return message.original_avatar;

    // Messages written before original_avatar existed only carry a name.
    const byName = (ctx.characters || []).find((c) => c.name === message.name);
    if (byName) return byName.avatar;
  }

  return null;
}

// A group chat has no characterId, so resolve its members instead.
function getActiveCharacters(ctx) {
  if (!ctx) return [];
  const allCharacters = ctx.characters || [];

  if (ctx.groupId) {
    const members = findGroup(ctx)?.members;
    if (!Array.isArray(members)) return [];

    // Show one member's images rather than the whole group's: a roster pin wins,
    // otherwise whoever spoke last. Both are checked against the member list, so
    // a pin or a speaker who has since left the group falls through to the group
    // as a whole — as does a chat where nobody has spoken yet.
    const only = [focusedAvatar, getLastSpeakerAvatar(ctx)].find(
      (avatar) => avatar && members.includes(avatar),
    );

    return (only ? [only] : members)
      .map((avatar) => allCharacters.find((c) => c.avatar === avatar))
      .filter(Boolean);
  }

  const id = ctx.characterId;
  if (id === undefined || id === null || id === "") return [];
  const char = allCharacters[id];
  return char ? [char] : [];
}

function getActiveLabel(ctx) {
  const active = getActiveCharacters(ctx);
  if (ctx?.groupId && active.length !== 1) return findGroup(ctx)?.name || "Group";
  return active[0]?.name || "";
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
function spawnGalleryWindow(images, charName) {
  $(`#${GALLERY_ID}`).remove();

  const gridHtml = images
    .map(
      (url, index) =>
        `<img src="${escapeHtml(url)}" class="civ-thumb" data-index="${index}" loading="lazy"
              alt="Image ${index + 1}" title="Open" role="button" tabindex="0" />`,
    )
    .join("");

  const html = `
      <div id="${GALLERY_ID}" class="civ-window-standard ss-dock">
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
// Shared by the viewer's round button and the roster footer's: reuse the last
// scan when there is one, otherwise scan now and report what it found.
function openGallery() {
  if (lastScannedImages.length > 0) {
    spawnGalleryWindow(lastScannedImages, lastScannedCharName);
  } else {
    performScan();
  }
}

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
  if (imageSettings.autoOpen && result && result.images.length > 0) {
    // Lead with whatever the greeting on screen points at.
    const startIndex = imageSettings.changeWithGreeting
      ? Math.max(0, getGreetingImageIndex(result.images))
      : 0;
    spawnSingleImageWindow(startIndex, result.images);
  }
}

// Follow the greeting: swiping to an alternate one, or opening another chat
// for the same character, changes which image is being talked about.
function retargetToGreeting() {
  if (!imageSettings.changeWithGreeting) return;
  if (!viewerState || $(`#${SINGLE_VIEWER_ID}`).length === 0) return;
  const index = getGreetingImageIndex(viewerState.images);
  if (index >= 0) updateImage(index);
}

function handleMessageSwiped(mesId) {
  if (Number(mesId) !== 0) return;
  retargetToGreeting();
}

/**
 * The image source itself changed — a different character is being shown — so
 * the viewer starts at the top of the new list rather than keeping its index.
 * A closed viewer is left closed: only a context change opens one uninvited.
 */
function refocusViewer() {
  if (lastContextKey === null) return;

  const result = scanAndGetImages();
  if (!result) return;

  if (viewerState && $(`#${SINGLE_VIEWER_ID}`).length > 0) {
    if (result.images.length === 0) {
      closeViewer();
    } else {
      viewerState.images = result.images;
      viewerState.failures = 0;
      updateImage(0);
    }
  }

  if ($(`#${GALLERY_ID}`).length > 0) {
    spawnGalleryWindow(result.images, result.charName);
  }
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

  if ($(`#${GALLERY_ID}`).length > 0) {
    spawnGalleryWindow(result.images, result.charName);
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

    $(".civ-window-frameless").each(function () {
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

function initImages() {
  const ctx = getSTContext();
  if (!ctx) {
    console.warn(logPrefix, "SillyTavern context unavailable; not starting.");
    return;
  }

  const { eventSource, eventTypes } = ctx;
  if (eventSource && eventTypes) {
    const onContentUpdate = debounce(handleContentUpdate, 250);
    eventSource.on(eventTypes.APP_READY, handleContextChange);
    eventSource.on(eventTypes.CHAT_CHANGED, handleContextChange);
    eventSource.on(eventTypes.CHARACTER_EDITED, onContentUpdate);
    eventSource.on(eventTypes.GROUP_UPDATED, onContentUpdate);
    eventSource.on(eventTypes.MESSAGE_SWIPED, handleMessageSwiped);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, refocusViewer);
    eventSource.on(eventTypes.MESSAGE_DELETED, refocusViewer);
  } else {
    console.warn(logPrefix, "Event source unavailable; auto-open disabled.");
  }

  handleContextChange();
}

// ═══════════════════════════ Boot ═══════════════════════════

jQuery(async () => {
    getSettings();
    // Before addSettings(), which paints the image checkboxes from it.
    loadImageSettings(getSTContext());
    addSettings();
    addWandButton();

    eventSource.on(event_types.APP_READY, pruneOrphanRosters);
    eventSource.on(event_types.CHAT_CHANGED, syncPanelToChat);
    eventSource.on(event_types.GROUP_UPDATED, refreshPanel);
    eventSource.on(event_types.GENERATION_ENDED, refreshPanel);
    eventSource.on(event_types.GENERATION_STOPPED, refreshPanel);

    initImages();
});
