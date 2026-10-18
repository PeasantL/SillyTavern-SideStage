/**
 * The Character Editor lock: SillyTavern's controls for what the editor manages, greyed out.
 */
import { characters, getRequestHeaders } from '../../../../../script.js';
import { selected_group, openGroupId } from '../../../../group-chats.js';
import { t } from '../../../../i18n.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { EDITOR_WINDOW, editorLink, getSettings, openInEditor } from './settings.js';
import { getSTContext } from './util.js';
import { getGroupWorld, worldLorebooks } from './worlds.js';

/*
 * The Character Editor owns cards, worlds' lorebooks and their groups: it
 * names media after the card file, keeps world membership in the lorebook and
 * backs up and trashes what it changes. Done in SillyTavern instead, these
 * break that (a rename moves the file, a delete skips the trash, a duplicate
 * shares the original's media), and SillyTavern's card save writes back its
 * whole copy of the card, loaded before the editor's last save. With the lock
 * on, those controls stay where they are but greyed out, like SillyTavern's
 * own unavailable settings, and do nothing.
 */

/** Card-panel controls locked while a card is being edited (not created). Some ids are on a button and a More… option both. */
const LOCKED_CARD_CONTROLS = '[id="renameCharButton"], [id="dupe_button"], [id="delete_button"], #favorite_button, #world_button, '
    + '[id="set_character_world"], #import_character_info, #replace_update';
/**
 * The Alternate Greetings popup's buttons, locked like the card's. Kept apart
 * from LOCKED_CARD_CONTROLS and without :is(): that list goes through jQuery's
 * .filter(), whose selector engine (jQuery 3.5) throws on :is().
 */
const LOCKED_GREETING_CONTROLS = '.alternate_grettings .add_alternate_greeting, .alternate_grettings .delete_alternate_greeting, '
    + '.alternate_grettings .move_up_alternate_greeting, .alternate_grettings .move_down_alternate_greeting';
/** The Alternate Greetings popup's fields; it still opens while locked, to read them, but they are read-only (see lockAlternateGreetings()). */
const ALTERNATE_GREETING_FIELDS = '.alternate_grettings textarea.alternate_greeting_text';
const LOCKED_IMPORT = '#character_import_button, #external_import_button, .external_import_button';
const LOCKED_CREATE = '#rm_button_create';
const LOCKED_WORLD_CONTROLS = '#world_popup_name_button, #world_duplicate, #world_popup_delete, #world_popup_new, '
    + '#world_backfill_memos, #world_apply_current_sorting, #world_popup_entries_list :is(.killSwitch, .menu_button, .drag-handle)';
/** The World Info editor's entries; a world's are read-only while locked (its fields are disabled, see lockWorldEntries()). */
const WORLD_ENTRIES = '#world_popup_entries_list';
const LOCKED_GROUP_CONTROLS = '#rm_group_delete, #rm_group_members [data-action="remove"], #rm_group_add_members [data-action="add"]';
/** Drop targets that take files for themselves (chat attachments, chat import, popups); a drop anywhere else imports cards. */
const OWN_DROP_TARGETS = '#form_sheld, #select_chat_popup, .popup';
/** Slash commands locked like their buttons; member ones only in a world's group. */
const LOCKED_COMMANDS = ['rename-char', 'char-delete', 'char-duplicate', 'char-update'];
const LOCKED_MEMBER_COMMANDS = ['member-add', 'member-remove'];

function isLocked() {
    return !!getSettings().lockManaged;
}

/** @returns {boolean} Whether the card panel is editing a saved card (not creating one). */
function isEditingCard() {
    return $('#form_create').attr('actiontype') === 'editcharacter';
}

/** @returns {boolean} Whether the World Info editor has a world's lorebook open. */
function isWorldInEditor() {
    const name = getWorldInEditor();
    return !!name && worldLorebooks.has(name);
}

/** @returns {boolean} Whether the group panel has a world's group open. */
function isWorldGroupOpen() {
    return !!openGroupId && !!getGroupWorld(openGroupId);
}

/**
 * Greys out the locked controls, or lets them go. Fields are disabled, which
 * also drops them from SillyTavern's card save; that is safe because the save
 * itself is cut down to the chat it records while locked (see lockedFetch()).
 */
export function applyLock() {
    const locked = isLocked();
    const fields = locked && isEditingCard();
    const form = /** @type {HTMLFormElement|null} */ (document.getElementById('form_create'));

    for (const el of form ? Array.from(form.elements) : []) {
        // Not the hidden fields or the submit button: SillyTavern's save still runs, cut down.
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || ['hidden', 'submit', 'button'].includes(el.type)) {
            continue;
        }
        if (fields && !el.disabled) {
            el.disabled = true;
            el.dataset.ssLocked = '';
        } else if (!fields && el.dataset.ssLocked !== undefined) {
            el.disabled = false;
            delete el.dataset.ssLocked;
        }
    }

    $('#char-management-dropdown option').filter(LOCKED_CARD_CONTROLS).prop('disabled', fields);
    lockWorldEntries();
    document.body.classList.toggle('ss-lock-card', fields);
    document.body.classList.toggle('ss-lock', locked);
    document.body.classList.toggle('ss-lock-world', locked && isWorldInEditor());
    document.body.classList.toggle('ss-lock-group', locked && isWorldGroupOpen());
}

/**
 * Disables the fields of the entries the World Info editor shows while it has
 * a world's lorebook open, or lets them go. SillyTavern saves a lorebook whole
 * from its own copy, so an edit there could put back what the Character Editor
 * changed meanwhile. The entries are drawn a page (and an opened entry) at a
 * time, so this runs again whenever the list changes.
 */
function lockWorldEntries() {
    const locked = isLocked() && isWorldInEditor();

    for (const el of document.querySelectorAll(`${WORLD_ENTRIES} :is(input, textarea, select)`)) {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) || el.type === 'hidden') {
            continue;
        }
        if (locked && !el.disabled) {
            el.disabled = true;
            el.dataset.ssLocked = '';
        } else if (!locked && el.dataset.ssLocked !== undefined) {
            el.disabled = false;
            delete el.dataset.ssLocked;
        }
    }
}

/** @returns {boolean} Whether the field with this id is locked (see applyLock()). */
function isLockedField(id) {
    const field = id ? document.getElementById(id) : null;
    return isLocked() && field?.dataset.ssLocked !== undefined;
}

/**
 * Disables the fields of the Alternate Greetings popup SillyTavern just opened
 * for a card being edited. They are marked like the card form's, so their ⛶
 * expanded editors are read-only too (see lockExpandedEditor()).
 */
function lockAlternateGreetings() {
    if (!isLocked() || !isEditingCard()) {
        return;
    }

    for (const el of document.querySelectorAll(ALTERNATE_GREETING_FIELDS)) {
        if (el instanceof HTMLTextAreaElement && !el.disabled) {
            el.disabled = true;
            el.dataset.ssLocked = '';
        }
    }
}

/** Makes the expanded editor of a locked field read-only and greys it like the field. */
function lockExpandedEditor(id) {
    if (!isLockedField(id)) {
        return;
    }

    for (const textarea of document.querySelectorAll('textarea.maximized_textarea')) {
        if (textarea instanceof HTMLTextAreaElement && textarea.dataset.for === id) {
            textarea.readOnly = true;
            textarea.classList.add('ss-locked-field');
        }
    }
}

/** @returns {string} The card file the card panel has open, or ''. */
function getOpenCardAvatar() {
    return String(characters[getSTContext().characterId]?.avatar ?? '');
}

/** @returns {string} The lorebook the World Info editor has open, or ''. */
function getWorldInEditor() {
    return $('#world_editor_select option:selected').text();
}

/**
 * Why a click on this element is locked, and what in the Character Editor to
 * open instead, or null.
 * @param {Element} el
 * @returns {{text: string, to: object}|null}
 */
function lockedReason(el) {
    if (!isLocked()) {
        return null;
    }
    if (el.closest(LOCKED_IMPORT)) {
        return { text: t`Import cards in the Character Editor.`, to: {} };
    }
    if (el.closest(LOCKED_CREATE)) {
        return { text: t`Create cards in the Character Editor.`, to: {} };
    }
    if (isEditingCard() && el.closest(`${LOCKED_CARD_CONTROLS}, ${LOCKED_GREETING_CONTROLS}`)) {
        return { text: t`This card is managed by the Character Editor; change it there.`, to: { card: getOpenCardAvatar() } };
    }
    if (isWorldInEditor() && el.closest(LOCKED_WORLD_CONTROLS)) {
        return { text: t`This lorebook is a world; edit it in the Character Editor.`, to: { world: getWorldInEditor() } };
    }
    if (isWorldGroupOpen() && el.closest(LOCKED_GROUP_CONTROLS)) {
        return {
            text: t`SideStage keeps this world's group in step with its cards; change the world in the Character Editor.`,
            to: { world: getGroupWorld(openGroupId) },
        };
    }
    return null;
}

/**
 * Why this locked field is read-only, and what in the Character Editor to
 * open instead, or null: a card's field (its form, Alternate Greetings, a ⛶
 * expanded editor) or a world's lorebook entry.
 * @param {Element} el
 * @returns {{text: string, to: object}|null}
 */
function lockedFieldReason(el) {
    if (!isLocked() || !el.closest('[data-ss-locked], .maximized_textarea.ss-locked-field')) {
        return null;
    }
    if (el.closest(WORLD_ENTRIES)) {
        return { text: t`This lorebook is a world; edit it in the Character Editor.`, to: { world: getWorldInEditor() } };
    }
    return { text: t`This card is managed by the Character Editor; change it there.`, to: { card: getOpenCardAvatar() } };
}

/**
 * Says a control is locked; with the Character Editor's address set, clicking
 * the message opens what it names there.
 * @param {string} reason
 * @param {object|null} [to] What to open (see editorLink()); null for no link
 */
function toastLocked(reason, to = null) {
    const href = to ? editorLink(to) : '';
    const more = to && Object.keys(to).length ? t`Click to open it there.` : t`Click to open the Character Editor.`;
    toastr.info(href ? `${reason} ${more}` : reason, t`Locked by SideStage`, {
        preventDuplicates: true,
        onclick: href ? () => window.open(href, EDITOR_WINDOW) : undefined,
    });
}

/**
 * SillyTavern's card save (/api/characters/edit) sends its whole copy of the
 * card. While locked nothing in it can have been changed here except which
 * chat the card last used, so only that is written, merged into the file as
 * it is now. SillyTavern then reloads the card from the file, as after any save.
 */
function watchCardSaves() {
    const nativeFetch = window.fetch;

    window.fetch = function (input, init) {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);

        if (isLocked() && url.pathname === '/api/characters/edit' && init?.body instanceof FormData) {
            const body = { avatar: String(init.body.get('avatar_url') ?? ''), chat: String(init.body.get('chat') ?? '') };
            return nativeFetch.call(window, '/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
        }

        return nativeFetch.call(window, input, init);
    };
}

/** Wraps the locked slash commands, so they report the lock instead of running. */
export function lockCommands() {
    const wrap = (name, when) => {
        const command = SlashCommandParser.commands[name];

        if (!command || command.ssLocked) {
            return;
        }

        const callback = command.callback;
        command.callback = function (...args) {
            if (isLocked() && when()) {
                toastLocked(t`/${name} is locked: SideStage leaves this to the Character Editor.`, {});
                return '';
            }
            return callback.apply(this, args);
        };
        command.ssLocked = true;
    };

    LOCKED_COMMANDS.forEach(name => wrap(name, () => true));
    LOCKED_MEMBER_COMMANDS.forEach(name => wrap(name, () => !!selected_group && !!getGroupWorld(selected_group)));
}

export function watchLock() {
    // Capture phase: ahead of SillyTavern's own handlers, including clicks
    // made from the keyboard, which the greyed-out styling doesn't stop.
    document.addEventListener('click', (e) => {
        const reason = e.target instanceof Element ? lockedReason(e.target) : null;

        if (reason) {
            e.preventDefault();
            e.stopImmediatePropagation();
            toastLocked(reason.text, reason.to);
        }
    }, true);

    // A locked field is disabled, so it gets no clicks, only pointer events: say why when it is tapped or
    // clicked. Not on pointerdown: a touch that turns into a scroll ends in pointercancel instead.
    document.addEventListener('pointerup', (e) => {
        const reason = e.target instanceof Element && e.button === 0 ? lockedFieldReason(e.target) : null;

        if (reason) {
            toastLocked(reason.text, reason.to);
        }
    }, true);

    // The Alternate Greetings popup opens for reading; its fields are drawn
    // by SillyTavern's handler, which runs after this one.
    document.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('.open_alternate_greetings')) {
            setTimeout(lockAlternateGreetings);
        }
    }, true);

    // The ⛶ expanded editor of a locked field: SillyTavern opens a free
    // textarea that types into the field, so make it read-only too.
    document.addEventListener('click', (e) => {
        const button = e.target instanceof Element ? e.target.closest('.editor_maximize') : null;
        if (button && isLocked()) {
            setTimeout(() => lockExpandedEditor(String(button.getAttribute('data-for') ?? '')));
        }
    }, true);
    document.addEventListener('beforeinput', (e) => {
        if (e.target instanceof HTMLTextAreaElement && e.target.matches('.maximized_textarea') && isLockedField(e.target.dataset.for)) {
            e.preventDefault();
        }
    }, true);

    // A file or link dropped on the page imports it as a card (text dropped in a field is left alone).
    window.addEventListener('drop', (e) => {
        const target = e.target instanceof Element ? e.target : null;
        const types = Array.from(e.dataTransfer?.types ?? []);
        const card = types.includes('Files') || types.includes('text/uri-list');

        if (isLocked() && card && !target?.closest(OWN_DROP_TARGETS)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            toastLocked(t`Import cards in the Character Editor.`, {});
        }
    }, true);

    // The card panel switches between editing and creating by this attribute.
    const form = document.getElementById('form_create');
    if (form) {
        new MutationObserver(applyLock).observe(form, { attributes: true, attributeFilter: ['actiontype'] });
    }

    // The group panel prints its members afresh for each group it opens.
    const members = document.getElementById('rm_group_members');
    if (members) {
        new MutationObserver(applyLock).observe(members, { childList: true });
    }

    // A world's entries are dragged into a new order by their handle.
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
        document.addEventListener(type, (e) => {
            if (e.target instanceof Element && e.target.closest(`${WORLD_ENTRIES} .drag-handle`) && isLocked() && isWorldInEditor()) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, { capture: true, passive: false });
    }

    const entries = document.querySelector(WORLD_ENTRIES);
    if (entries) {
        let queued = false;
        new MutationObserver(() => {
            if (!queued) {
                queued = true;
                setTimeout(() => { queued = false; lockWorldEntries(); });  // not requestAnimationFrame: it waits while the tab is hidden
            }
        }).observe(entries, { childList: true, subtree: true });
    }

    // Like SillyTavern's own notice over Advanced Formatting's greyed-out options; shown by style.css (ss-lock-world).
    $('#WorldInfo > .flex-container').first().after(`
        <div id="ss_world_lock_notice" class="info-block warning">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>${t`This lorebook is a world: greyed-out options are managed by the Character Editor.`}</span>
            <a id="ss_world_lock_open" class="ss-editor-link" href="#">${t`Open it there`}</a>
        </div>`);
    $('#ss_world_lock_open').on('click', (e) => {
        e.preventDefault();
        openInEditor({ world: getWorldInEditor() });
    });

    $(document).on('change', '#world_editor_select', applyLock);
    watchCardSaves();
    applyLock();
}
