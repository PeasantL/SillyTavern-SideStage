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

const rosterDefaults = {
    /** @type {{id: string, name: string, cards: string[], note: string}[]} */
    rosters: [],
    /** @type {string} Id of the roster the panel displays. */
    activeRosterId: '',
};

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
            settings.rosters.push({ id: uuidv4(), name: t`Default`, cards: settings.cards, note: '' });
        }
        delete settings.cards;
    }

    if (!settings.rosters.length) {
        settings.rosters.push({ id: uuidv4(), name: t`Default`, cards: [], note: '' });
    }

    for (const roster of settings.rosters) {
        if (typeof roster.note !== 'string') {
            roster.note = '';
        }
    }

    if (!settings.rosters.some(x => x.id === settings.activeRosterId)) {
        settings.activeRosterId = settings.rosters[0].id;
    }

    return settings;
}

/** @returns {{id: string, name: string, cards: string[], note: string}} The roster the panel shows. */
function getActiveRoster() {
    const settings = getSettings();
    return settings.rosters.find(x => x.id === settings.activeRosterId) ?? settings.rosters[0];
}

/** @returns {string[]} Avatar file names in the active roster. */
function getActiveCards() {
    return getActiveRoster()?.cards ?? [];
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
 * Whether the active roster's note is currently the chat's Author's Note.
 * Derived from the live field rather than stored, so the toggle still tells
 * the truth after the note is edited by hand or the chat is switched.
 * @returns {boolean}
 */
function isNoteApplied() {
    const note = getActiveRoster()?.note ?? '';
    return Boolean(note) && getChatAuthorsNote() === note;
}

/**
 * Applies the active roster's Author's Note to the current chat, or clears the
 * chat's note when switched off.
 * @param {boolean} shouldApply
 */
function setNoteApplied(shouldApply) {
    const roster = getActiveRoster();

    if (shouldApply && !roster?.note) {
        toastr.info(t`This roster has no Author's Note. Set one in Extensions → Group Roster.`);
        return;
    }

    setChatAuthorsNote(shouldApply ? roster.note : '');
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
        noteToggle.disabled = !getActiveRoster()?.note;
    }

    if (!cards.length) {
        const empty = document.createElement('div');
        empty.classList.add('gr-empty');
        empty.textContent = t`No cards in this roster. Add them in Extensions → Group Roster.`;
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
                <span class="gr-title">${t`Group Roster`}<small id="groupRosterStatus" class="gr-status"></small></span>
            </div>
            <div class="gr-body">
                <div id="groupRosterList" class="gr-grid"></div>
            </div>
            <div class="gr-footer">
                <label id="groupRosterNoteToggle" class="gr-footer-btn gr-footer-toggle"
                       title="${t`Fill this chat's Author's Note with the active roster's note`}">
                    <input type="checkbox">
                    <i class="fa-solid fa-note-sticky fa-fw"></i>
                    <span>${t`Author's Note`}</span>
                </label>
            </div>
        </div>`;

    $('body').append(html);
    const $win = $(`#${PANEL_ID}`);

    $win.find('#groupRosterNoteToggle input').on('change', function () {
        setNoteApplied(this.checked);
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
                <label for="gr_roster_select">Active roster</label>
                <div class="flex-container alignItemsCenter">
                    <select id="gr_roster_select" class="text_pole flex1"></select>
                    <div id="gr_roster_new" class="menu_button menu_button_icon interactable" title="New roster">
                        <i class="fa-solid fa-plus fa-fw"></i>
                    </div>
                    <div id="gr_roster_rename" class="menu_button menu_button_icon interactable" title="Rename roster">
                        <i class="fa-solid fa-pen fa-fw"></i>
                    </div>
                    <div id="gr_roster_delete" class="menu_button menu_button_icon interactable" title="Delete roster">
                        <i class="fa-solid fa-trash fa-fw"></i>
                    </div>
                </div>
                <label for="gr_roster_note">Author's Note for this roster</label>
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
                <div class="ss-settings-heading">Images</div>
                <label class="checkbox_label" for="civ-auto-open" title="Opens the floating viewer whenever a character or group with images is selected.">
                    <input id="civ-auto-open" type="checkbox">
                    <span>Open the viewer automatically on character select</span>
                </label>
                <small class="civ-settings-note">
                    Turning this off leaves no way to open the viewer, since the gallery is reached from it.
                </small>
                <label class="checkbox_label" for="civ-change-with-greeting" title="Opens on the image referenced by the greeting on screen, and switches when you swipe to an alternate greeting.">
                    <input id="civ-change-with-greeting" type="checkbox">
                    <span>Change with Greeting</span>
                </label>
                <small class="civ-settings-note">
                    With this off, the viewer opens on the first image found and stays put until you navigate it yourself.
                </small>
            </div>
        </div>
    </div>
</div>`;

/** Fills the roster dropdown from settings. */
function renderRosterSelect() {
    const settings = getSettings();
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('gr_roster_select'));

    if (!select) {
        return;
    }

    select.innerHTML = '';

    for (const roster of settings.rosters) {
        const option = document.createElement('option');
        option.value = roster.id;
        option.textContent = `${roster.name} (${roster.cards.length})`;
        select.appendChild(option);
    }

    select.value = settings.activeRosterId;
    // Deleting the last roster is blocked so there is always one to fall back to.
    $('#gr_roster_delete').toggleClass('disabled', settings.rosters.length <= 1);
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
        const roster = getActiveRoster();
        const index = roster.cards.indexOf(character.avatar);

        if (isMember && index !== -1) {
            roster.cards.splice(index, 1);
        } else if (!isMember && index === -1) {
            roster.cards.push(character.avatar);
        }

        saveSettingsDebounced();
        renderRosterSelect();
        renderRosterLists();
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

    const roster = getActiveRoster();
    const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('gr_settings_search'));
    const term = (searchInput?.value ?? '').trim().toLowerCase();

    inList.innerHTML = '';
    outList.innerHTML = '';

    const inCount = document.getElementById('gr_in_count');
    if (inCount) {
        inCount.textContent = String(roster.cards.length);
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
    renderRosterSelect();
    renderRosterLists();
    $('#gr_roster_note').val(getActiveRoster()?.note ?? '');
}

function addSettings() {
    $('#extensions_settings2').append(settingsHtml);

    $('#gr_roster_select').on('change', function () {
        getSettings().activeRosterId = String($(this).val());
        saveSettingsDebounced();
        renderRosterLists();
        $('#gr_roster_note').val(getActiveRoster()?.note ?? '');
        refreshPanel();
    });

    $('#gr_roster_new').on('click', async () => {
        const name = await Popup.show.input(t`New roster`, t`Name for the new roster`, '');

        if (!name) {
            return;
        }

        const settings = getSettings();
        const roster = { id: uuidv4(), name: String(name).trim(), cards: [], note: '' };
        settings.rosters.push(roster);
        settings.activeRosterId = roster.id;
        saveSettingsDebounced();
        renderSettings();
        refreshPanel();
    });

    $('#gr_roster_rename').on('click', async () => {
        const roster = getActiveRoster();
        const name = await Popup.show.input(t`Rename roster`, t`New name`, roster.name);

        if (!name) {
            return;
        }

        roster.name = String(name).trim();
        saveSettingsDebounced();
        renderRosterSelect();
    });

    $('#gr_roster_delete').on('click', async () => {
        const settings = getSettings();

        if (settings.rosters.length <= 1) {
            toastr.warning(t`The last roster can't be deleted.`);
            return;
        }

        const roster = getActiveRoster();
        const confirmed = await Popup.show.confirm(t`Delete roster`, t`Delete "${roster.name}"? Its card list is lost.`);

        if (!confirmed) {
            return;
        }

        settings.rosters = settings.rosters.filter(x => x.id !== roster.id);
        settings.activeRosterId = settings.rosters[0].id;
        saveSettingsDebounced();
        renderSettings();
        refreshPanel();
    });

    $('#gr_roster_note').on('input', function () {
        getActiveRoster().note = String($(this).val());
        saveSettingsDebounced();
        // The footer toggle greys out for a roster with no note, and its
        // checked state compares against this text.
        refreshPanel();
    });

    $('#gr_settings_search').on('input', renderRosterLists);

    $('#gr_settings_clear').on('click', () => {
        getActiveRoster().cards = [];
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

function bringToFront($win) {
  $(".civ-window-standard, .civ-window-frameless").css("z-index", 500);
  $win.css("z-index", 501);
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

// A group chat has no characterId, so resolve its members instead.
function getActiveCharacters(ctx) {
  if (!ctx) return [];
  const allCharacters = ctx.characters || [];

  if (ctx.groupId) {
    const members = findGroup(ctx)?.members;
    if (!Array.isArray(members)) return [];
    return members
      .map((avatar) => allCharacters.find((c) => c.avatar === avatar))
      .filter(Boolean);
  }

  const id = ctx.characterId;
  if (id === undefined || id === null || id === "") return [];
  const char = allCharacters[id];
  return char ? [char] : [];
}

function getActiveLabel(ctx) {
  if (ctx?.groupId) return findGroup(ctx)?.name || "Group";
  return getActiveCharacters(ctx)[0]?.name || "";
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
  bringToFront($win);

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
  $win.on("mousedown", function () {
    bringToFront($(this));
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
    bringToFront(viewerState.$win);
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
    bringToFront($win);

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
    const openGallery = () => {
      if (lastScannedImages.length > 0) {
        spawnGalleryWindow(lastScannedImages, lastScannedCharName);
      } else {
        performScan();
      }
    };
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
    $win.on("mousedown", function () {
      bringToFront($(this));
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

    eventSource.on(event_types.CHAT_CHANGED, syncPanelToChat);
    eventSource.on(event_types.GROUP_UPDATED, refreshPanel);
    eventSource.on(event_types.GENERATION_ENDED, refreshPanel);
    eventSource.on(event_types.GENERATION_STOPPED, refreshPanel);

    initImages();
});
