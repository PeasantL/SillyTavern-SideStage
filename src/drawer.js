/**
 * The settings drawer (Extensions → SideStage).
 */
import { saveSettingsDebounced } from '../../../../../script.js';
import { groups } from '../../../../group-chats.js';
import { t } from '../../../../i18n.js';
import { applyEditorLinks, getSettings, openInEditor } from './settings.js';
import { getCurrentGroup } from './util.js';
import { getGroupWorld, getWorldGroups, pullWorldStage, refreshWorlds } from './worlds.js';
import { imageSettings } from './images.js';
import { applyLock } from './lock.js';

/**
 * Group whose stage the settings drawer edits. Empty means "follow the open
 * group", which is the state it returns to whenever the chat changes.
 * @type {string}
 */
let settingsGroupId = '';

/** Hands the drawer back to the open group (on a chat change). */
export function resetSettingsGroup() {
    settingsGroupId = '';
}

/** @returns {string} Id of the world group the settings drawer is editing: the open one, if it is a world's. */
function getSettingsGroupId() {
    const worldGroups = getWorldGroups();

    if (settingsGroupId && worldGroups.some(x => x.id === settingsGroupId)) {
        return settingsGroupId;
    }

    const current = getCurrentGroup();
    return (current && getGroupWorld(current.id) ? current.id : worldGroups[0]?.id) ?? '';
}

/** @returns {object|null} The group the settings drawer edits. */
function getSettingsGroup() {
    return groups.find(x => x.id === getSettingsGroupId()) ?? null;
}



const settingsHtml = `
<div class="sidestage-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>SideStage</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="ss-settings-section">
                <div class="ss-settings-heading">Group</div>
                <label for="gr_group_select">Group</label>
                <select id="gr_group_select" class="text_pole"></select>
                <div class="flex-container alignItemsCenter">
                    <small id="gr_world_status" class="ss-settings-hint flex1"></small>
                    <div id="gr_world_sync" class="menu_button menu_button_icon interactable" title="Reload the characters, create the groups worlds are missing, and bring every world's group in step with its cards">
                        <i class="fa-solid fa-rotate fa-fw"></i>
                    </div>
                </div>
                <div class="flex-container alignItemsCenter">
                    <small class="ss-settings-hint flex1">The group's Author's Note and layouts are written in the Character Editor's World section.</small>
                    <div id="gr_world_open" class="menu_button menu_button_icon interactable ss-editor-link" title="Open this world in the Character Editor">
                        <i class="fa-solid fa-pen-to-square fa-fw"></i>
                    </div>
                </div>
            </div>

            <div class="ss-settings-divider"></div>

            <div class="ss-settings-section">
                <div class="ss-settings-heading">Entrances and exits</div>
                <label for="ss_enter_line">Narrator, as someone enters</label>
                <input id="ss_enter_line" class="text_pole" type="text" placeholder="{{char}} entered the scene.">
                <label for="ss_exit_line">Narrator, as someone leaves</label>
                <input id="ss_exit_line" class="text_pole" type="text" placeholder="{{char}} left the scene.">
                <small class="ss-settings-hint">The roster's first toggle plays it out: bringing someone in posts the first line, then they speak; sending them off has them speak, then posts the second. <code>{{char}}</code> is them. Blank restores the default.</small>
            </div>

            <div class="ss-settings-divider"></div>

            <div class="ss-settings-section">
                <div class="ss-settings-heading">Rewrite</div>
                <small class="ss-settings-hint">The rewrites run on the connection profile selected in SillyTavern (or the active connection when none is), and the asides send the whole chat.</small>
                <label for="ss_morality_request">Morality asks</label>
                <textarea id="ss_morality_request" class="text_pole textarea_compact" rows="2"
                          placeholder="Describe the evil of the current scene in detail."></textarea>
                <label for="ss_scene_request">Scene asks</label>
                <textarea id="ss_scene_request" class="text_pole textarea_compact" rows="2"
                          placeholder="Describe the current scene in detail."></textarea>
                <small class="ss-settings-hint">Each is sent as <code>[OOC: Pause the roleplay and respond out of character. …]</code> through the message box, like a Quick Reply. Blank restores the default.</small>
            </div>

            <div class="ss-settings-divider"></div>

            <div class="ss-settings-section">
                <div class="ss-settings-heading">Character Editor</div>
                <label for="ss_editor_url">Address</label>
                <input id="ss_editor_url" class="text_pole" type="url" placeholder="https://host:1019/">
                <small class="ss-settings-hint">The Character Editor as this browser opens it. With it set, locked controls, the World Info notice and the layout picker link to it; blank, they don't.</small>
                <div class="ss-settings-toggles">
                    <label class="checkbox_label" for="ss_lock_managed" title="Greys out what the Character Editor manages, so SillyTavern can't change it behind the editor's back: card fields, avatar, favourite and lorebook link; new card, import, rename, duplicate and delete; renaming, duplicating and deleting a world's lorebook; deleting a world's group and adding or removing its members.">
                        <input id="ss_lock_managed" type="checkbox">
                        <span>Lock what the Character Editor manages</span>
                    </label>
                </div>
                <small class="ss-settings-hint">Saves SillyTavern still makes (which chat a card last used) only write that, never a whole card over the editor's changes.</small>
            </div>

            <div class="ss-settings-divider"></div>

            <div class="ss-settings-section">
                <div class="ss-settings-heading">Images</div>
                <div class="ss-settings-toggles">
                    <label class="checkbox_label" for="civ-change-with-greeting" title="Opens on the image referenced by the greeting on screen, and switches when you swipe to an alternate greeting. With this off the viewer opens on the first image found and stays put until you navigate it yourself.">
                        <input id="civ-change-with-greeting" type="checkbox">
                        <span>Change with greeting</span>
                    </label>
                </div>
            </div>
        </div>
    </div>
</div>`;

/** Fills the group dropdown with the worlds' groups; it picks the stage being edited. */
function renderGroupSelect() {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('gr_group_select'));

    if (!select) {
        return;
    }

    const worldGroups = getWorldGroups();
    select.innerHTML = '';
    select.disabled = !worldGroups.length;

    if (!worldGroups.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = t`No world groups yet`;
        select.appendChild(option);
        return;
    }

    for (const group of worldGroups) {
        const option = document.createElement('option');
        option.value = group.id;
        // A world's group is named after its world, so the name says both.
        option.textContent = `${group.name} (${group.members?.length ?? 0})`;
        select.appendChild(option);
    }

    select.value = getSettingsGroupId();
}

/** Says what the drawer's group is, or why there is none. */
function renderWorldRow() {
    const status = document.getElementById('gr_world_status');

    if (!status) {
        return;
    }

    status.textContent = getSettingsGroup()
        ? t`A world's group: its members are the world's cards, and they join and leave with the world. Mute and unmute them from the panel.`
        : t`No world groups yet. Every world (a lorebook made a world in the Character Editor) gets its own group once it has a card; layouts (edited in the Character Editor) and the Author's Note belong to those groups.`;
}

export function renderSettings() {
    if (!document.getElementById('gr_group_select')) {
        return;
    }

    renderGroupSelect();
    renderWorldRow();
    $('#ss_editor_url').val(getSettings().editorUrl ?? '');
    $('#ss_morality_request').val(getSettings().moralityRequest ?? '');
    $('#ss_scene_request').val(getSettings().sceneRequest ?? '');
    $('#ss_enter_line').val(getSettings().enterLine ?? '');
    $('#ss_exit_line').val(getSettings().exitLine ?? '');
}

export function addSettings() {
    $('#extensions_settings2').append(settingsHtml);

    $('#ss_morality_request').on('input', function () {
        getSettings().moralityRequest = String($(this).val());
        saveSettingsDebounced();
    });

    $('#ss_scene_request').on('input', function () {
        getSettings().sceneRequest = String($(this).val());
        saveSettingsDebounced();
    });

    $('#ss_enter_line').on('input', function () {
        getSettings().enterLine = String($(this).val());
        saveSettingsDebounced();
    });

    $('#ss_exit_line').on('input', function () {
        getSettings().exitLine = String($(this).val());
        saveSettingsDebounced();
    });

    $('#gr_group_select').on('change', function () {
        settingsGroupId = String($(this).val());
        renderSettings();
    });

    $('#gr_world_sync').on('click', async () => {
        const $button = $('#gr_world_sync');

        if ($button.hasClass('disabled')) {
            return;
        }

        $button.addClass('disabled');

        try {
            await refreshWorlds({ reload: true });
        } finally {
            $button.removeClass('disabled');
        }
    });

    $('#gr_world_open').on('click', () => {
        const world = getGroupWorld(getSettingsGroupId());
        openInEditor(world ? { world } : {});
    });

    $('#ss_editor_url').on('input', function () {
        getSettings().editorUrl = String($(this).val()).trim();
        saveSettingsDebounced();
        applyEditorLinks();
    });

    // Characters may still be loading when the drawer is built, so repaint the
    // lists whenever it is opened rather than trusting the one-shot render.
    $(document).on('click', '.sidestage-settings .inline-drawer-toggle', () => {
        renderSettings();
        const world = getGroupWorld(getSettingsGroupId());

        if (world) {
            pullWorldStage(world).catch(error => console.error('[SideStage] Could not read the world\'s layouts', error));
        }
    });

    $('#ss_lock_managed')
        .prop('checked', !!getSettings().lockManaged)
        .on('change', function () {
            getSettings().lockManaged = !!$(this).prop('checked');
            saveSettingsDebounced();
            applyLock();
        });

    // Image half of the same drawer.
    $('#civ-change-with-greeting')
        .prop('checked', !!imageSettings.changeWithGreeting)
        .on('change', function () {
            imageSettings.changeWithGreeting = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    renderSettings();
}
