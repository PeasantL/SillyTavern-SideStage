/**
 * The strip on the right edge and the roster panel in it: cards, mute and turn controls, the layout picker.
 */
import { characters, getThumbnailUrl } from '../../../../../script.js';
import { groups, selected_group, editGroup } from '../../../../group-chats.js';
import { t } from '../../../../i18n.js';
import { openInEditor } from './settings.js';
import { getCharacterByAvatar, getCurrentGroup } from './util.js';
import { GROUP_LAYOUT_KEY, getActiveLayout, getActiveStage, getGroupWorld, pullWorldStage, refreshWorlds, syncWorldGroup } from './worlds.js';
import { applyLayoutMutes, forceTurn, getEffectiveNote, isNoteApplied, setMuted, setNoteApplied, syncNoteToChat } from './scene.js';
import { renderSettings, resetSettingsGroup } from './drawer.js';
import { refocusViewer } from './images.js';

const PANEL_ID = 'groupRoster';
/**
 * Avatar the viewer is pinned to, or null to follow whoever spoke last.
 * Deliberately not persisted: it is a way to look at one character for a
 * moment, not a property of the roster, so it resets with the chat.
 * @type {string|null}
 */
export let focusedAvatar = null;

/**
 * Pins the viewer to one character, or hands it back to the last speaker.
 * @param {string|null} avatar
 */
function setFocusedAvatar(avatar) {
    focusedAvatar = avatar;
    refreshPanel();
    refocusViewer();
}



// The strip: one fixed column on the right edge holding everything SideStage
// shows — the roster, the gallery and the image — stacked as sections of one
// panel rather than as separate windows. Sections mount into it as they open;
// it goes away with its last one. Their order on screen is set in style.css,
// so the order they happen to open in does not matter.
const STRIP_ID = 'sideStage';

export function mountInStrip(html) {
    let $strip = $(`#${STRIP_ID}`);
    if (!$strip.length) {
        $strip = $(`<div id="${STRIP_ID}" class="ss-strip"></div>`).appendTo('body');
        // Catches a #sheld that moved without resizing (a class toggled on body).
        measureStrip();
    }
    return $(html).appendTo($strip);
}

export function pruneStrip() {
    const $strip = $(`#${STRIP_ID}`);
    if ($strip.length && !$strip.children('.ss-section').length) {
        $strip.remove();
    }
}

// The strip spans exactly what the chat column does: from #sheld's top to the
// bottom of the message box. Measured rather than restated in CSS, because
// core sizes #sheld differently per platform — on iOS the home-screen app pads
// its bottom by the home indicator's inset (15px at least), and a strip run to
// the screen's edge overshot the message box by that much. Layout offsets and
// computed styles, never getBoundingClientRect(), which iOS reports against
// the visual viewport while the toolbar animates. The message box's rounded
// bottom corner is read too, so the strip's matching corner follows a theme
// that changes it. Written to custom properties on <html>; style.css falls
// back to a full-height column until the first measurement lands.
function measureStrip() {
    const sheld = document.getElementById('sheld');
    const form = document.getElementById('form_sheld');
    if (!sheld || !form || !sheld.offsetHeight) {
        return;
    }
    const top = parseFloat(getComputedStyle(sheld).top);
    const height = sheld.clientTop + form.offsetTop + form.offsetHeight;
    const root = document.documentElement.style;
    root.setProperty('--ss-strip-top', `${Number.isFinite(top) ? top : sheld.offsetTop}px`);
    root.setProperty('--ss-strip-height', `${height}px`);
    const sendForm = document.getElementById('send_form');
    if (sendForm) {
        root.setProperty('--ss-strip-radius', getComputedStyle(sendForm).borderBottomLeftRadius);
    }
}

// #sheld changes size on rotation, on a theme or chat-width change, and when
// the message box grows a line; observing both covers them all.
export function watchStrip() {
    const sheld = document.getElementById('sheld');
    const form = document.getElementById('form_sheld');
    if (!sheld || !form) {
        return;
    }
    const observer = new ResizeObserver(() => measureStrip());
    observer.observe(sheld);
    observer.observe(form);
    window.addEventListener('resize', measureStrip);
    measureStrip();
}

function isPanelOpen() {
    return $(`#${PANEL_ID}`).length > 0;
}

function closePanel() {
    const $win = $(`#${PANEL_ID}`);

    if (!$win.length) {
        return;
    }

    $win.remove();
    pruneStrip();
}

/**
 * Builds one compact card row: avatar, name, and the two inline icon toggles.
 * @param {string} avatar Avatar file name
 * @returns {HTMLElement}
 */
function makeCardRow(avatar) {
    const character = getCharacterByAvatar(avatar);
    const group = getCurrentGroup();
    const isMuted = Boolean(group?.disabled_members?.includes(avatar));

    const row = document.createElement('div');
    row.classList.add('gr-card');
    row.classList.toggle('gr-muted', isMuted);
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

    // Toggle 1: in the scene (unmuted) or muted
    const member = makeIconToggle('gr-member', 'fa-user-check', isMuted
        ? t`Muted: not picked to reply. Click to bring into the scene`
        : t`In the scene. Click to mute`);
    member.input.checked = !isMuted;
    member.input.disabled = !group || !character;
    member.input.addEventListener('change', async () => {
        const inScene = member.input.checked;
        member.input.disabled = true;
        try {
            const changed = await setMuted(avatar, !inScene);
            if (!changed) {
                member.input.checked = !inScene;
            }
        } finally {
            member.input.disabled = false;
            refreshPanel();
        }
    });
    row.appendChild(member.label);

    // Toggle 2: force a turn (self-resets once generation finishes). Only for
    // members in the scene: a muted character is greyed out until unmuted.
    const turn = makeIconToggle('gr-turn', 'fa-comment-dots', isMuted
        ? t`Muted: bring into the scene to give them a turn`
        : t`Make this character speak next`);
    turn.input.disabled = !group || !character || isMuted;
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
 * Used by the panel footer's picker (layouts are edited in the Character Editor).
 * @param {string} id
 */
async function setActiveLayout(id) {
    const group = getCurrentGroup();

    if (!group || !getActiveStage()) {
        return;
    }

    group[GROUP_LAYOUT_KEY] = String(id);
    // The new layout may override the group's note, or stop overriding it.
    syncNoteToChat();

    try {
        // Applying the mutes saves the group; when they are already right, save it for the choice alone.
        if (!(await applyLayoutMutes())) {
            await editGroup(group.id, true, false);
        }
    } catch (error) {
        console.error('[SideStage] Failed to apply the layout', error);
        toastr.error(error?.message || t`Unknown error`, t`Failed to apply the layout`);
    }

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

    const stage = getActiveStage();
    const layouts = stage?.layouts ?? [];
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

    picker.value = getActiveLayout(getCurrentGroup()?.id)?.id ?? '';
    picker.disabled = !stage;
    $('#groupRosterLayoutEdit').toggleClass('ss-no-stage', !stage);
    picker.title = stage || !getCurrentGroup() ? '' : t`Layouts are for worlds' groups`;
}

/** Re-renders the card list inside an already open panel. */
export function refreshPanel() {
    const list = document.getElementById('groupRosterList');
    if (!list) {
        return;
    }

    const group = getCurrentGroup();
    const world = group ? getGroupWorld(group.id) : '';
    const cards = group?.members ?? [];
    list.innerHTML = '';

    const status = document.getElementById('groupRosterStatus');
    if (status) {
        status.textContent = group ? group.name : t`No group chat open`;
        status.title = world ? t`Members follow the world "${world}"` : '';
        status.classList.toggle('gr-warning', !group);
    }

    const sync = document.getElementById('groupRosterSync');
    if (sync) {
        sync.style.display = world ? '' : 'none';
        sync.title = t`Reload the characters and bring this group in step with "${world}"`;
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
        empty.textContent = group ? t`This group has no members.` : t`Open a group chat.`;
        list.appendChild(empty);
        return;
    }

    for (const avatar of cards) {
        list.appendChild(makeCardRow(avatar));
    }
}

/**
 * Mounts the roster as the strip's top section, or takes it out again.
 * Deliberately avoids ST's built-in draggable stack, which inherits the core
 * `.draggable` rule that forces 100vw/100vh below 1000px and eats the whole
 * screen on a tablet.
 */
function openPanel() {
    if (isPanelOpen()) {
        closePanel();
        return;
    }

    const html = `
        <div id="${PANEL_ID}" class="ss-section gr-panel">
            <div class="gr-header">
                <span class="gr-title">${t`SideStage`}<small id="groupRosterStatus" class="gr-status"></small></span>
                <div id="groupRosterSync" class="gr-header-btn fa-solid fa-rotate fa-fw interactable" tabindex="0"></div>
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
                <div id="groupRosterLayoutEdit" class="gr-footer-btn ss-editor-link fa-solid fa-pen-to-square fa-fw interactable" tabindex="0"
                     title="${t`Edit the layouts in the Character Editor`}"></div>
            </div>
        </div>`;

    const $win = mountInStrip(html);

    $win.find('#groupRosterSync').on('click keydown', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') {
            return;
        }
        e.preventDefault();
        $(this).addClass('fa-spin');
        refreshWorlds({ reload: true }).finally(() => $('#groupRosterSync').removeClass('fa-spin'));
    });

    $win.find('#groupRosterNoteToggle input').on('change', function () {
        setNoteApplied(this.checked);
    });

    $win.find('#groupRosterLayoutEdit').on('click keydown', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') {
            return;
        }
        e.preventDefault();
        const group = getCurrentGroup();
        const world = group ? getGroupWorld(group.id) : '';

        if (world) {
            openInEditor({ world, layout: getActiveLayout(group.id)?.id ?? '' });
        }
    });

    $win.find('#groupRosterLayoutPicker').on('change', function () {
        const picker = this;
        picker.disabled = true;
        setActiveLayout(String($(picker).val())).finally(() => {
            picker.disabled = false;
        });
    });

    refreshPanel();
}


/**
 * Opens the roster when a group chat is selected and closes it otherwise, so
 * the window follows the chat rather than lingering over a solo character.
 * The wand button still toggles it by hand within a group.
 */
export function syncPanelToChat() {
    focusedAvatar = null;
    // The new chat brings its own toggle state; honour it before anything
    // repaints from it.
    syncNoteToChat();
    // Hand the drawer back to the open group; a hand-picked group only outlives
    // the chat it was picked during if the user picks it again.
    resetSettingsGroup();

    if ($('.sidestage-settings .inline-drawer-content').is(':visible')) {
        renderSettings();
    }

    if (!selected_group) {
        closePanel();
        return;
    }

    const world = getGroupWorld(selected_group);

    if (world) {
        syncWorldGroup(selected_group).catch(error => console.error('[SideStage] Could not sync the world group', error));
        pullWorldStage(world).catch(error => console.error('[SideStage] Could not read the world\'s layouts', error));
    }

    if (isPanelOpen()) {
        refreshPanel();
        return;
    }

    openPanel();
}

export function addWandButton() {
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
