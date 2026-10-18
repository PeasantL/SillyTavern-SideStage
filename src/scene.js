/**
 * The open group's scene: mutes, the opening a layout writes, forced turns and the Author's Note toggle.
 */
import { eventSource, event_types, characters, getThumbnailUrl, isGenerating, Generate, menu_type, sendMessageAsUser, extractMessageBias, chat, chat_metadata, addOneMessage, substituteParams, system_message_types, system_avatar, default_avatar, saveChatConditional } from '../../../../../script.js';
import { getMessageTimeStamp } from '../../../../RossAscends-mods.js';
import { saveMetadataDebounced } from '../../../../extensions.js';
import { selected_group, openGroupId, editGroup, unshallowGroupMembers, select_group_chats } from '../../../../group-chats.js';
import { waitUntilCondition } from '../../../../utils.js';
import { t } from '../../../../i18n.js';
import { getLayoutEntry, getLayoutOrder, getTurnText } from './stage.js';
import { getCharacterByAvatar, getCurrentGroup } from './util.js';
import { getActiveLayout, getActiveStage, getGroupWorld } from './worlds.js';
import { refreshPanel } from './panel.js';

/** Chat-scoped display name for narrator messages, set by ST's /sysname. */
const NARRATOR_NAME_KEY = 'narrator_name';
/** Where the Author's Note extension keeps the chat's note (its metadata_keys.prompt). */
const NOTE_PROMPT_KEY = 'note_prompt';
/** Chat-scoped state of the footer's Author's Note toggle. */
const NOTE_APPLIED_KEY = 'sidestage_note_applied';


/**
 * Re-renders the Group Control panel's member and candidate lists.
 * editGroup() only persists the roster; the two lists are painted by
 * printGroupMembers()/printGroupCandidates(), which aren't exported, so they
 * stay stale until the group card is reselected. select_group_chats() calls
 * both. skipAnimation = true so it repaints in place without yanking the
 * right-hand menu open.
 */
export function refreshGroupControlPanel() {
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
 * Mutes or unmutes a member of the open group chat. Muted members stay in the
 * group (and in its prompt as far as the group's settings say) but aren't
 * picked to reply, and can't be given a forced turn.
 * @param {string} avatar Avatar file name of the character
 * @param {boolean} shouldMute Target state: true = muted, false = in the scene
 * @returns {Promise<boolean>} Whether the group was actually changed
 */
export async function setMuted(avatar, shouldMute) {
    const group = getCurrentGroup();

    if (!group || !Array.isArray(group.members)) {
        toastr.warning(t`Open a group chat first.`);
        return false;
    }

    if (!group.members.includes(avatar)) {
        return false;
    }

    if (!Array.isArray(group.disabled_members)) {
        group.disabled_members = [];
    }

    const index = group.disabled_members.indexOf(avatar);

    if (shouldMute === (index !== -1)) {
        return false;
    }

    if (shouldMute) {
        group.disabled_members.push(avatar);
    } else {
        group.disabled_members.splice(index, 1);
    }

    // immediately = true so the mute is on disk before anything can generate,
    // reload = false so the character list / group panel isn't torn down under us.
    await editGroup(selected_group, true, false);
    refreshGroupControlPanel();
    await eventSource.emit(event_types.GROUP_UPDATED);
    return true;
}

/**
 * Mutes the open group's members as the selected layout says: whoever is in
 * the scene is unmuted, everyone else is muted. Members are never added or
 * removed here.
 * @returns {Promise<boolean>} Whether the group was actually changed
 */
export async function applyLayoutMutes() {
    const group = getCurrentGroup();
    const layout = getActiveLayout(getCurrentGroup()?.id);

    if (!group || !Array.isArray(group.members) || !layout) {
        return false;
    }

    if (!isLayoutUsable(group, layout)) {
        toastr.warning(t`"${layout.name}" has nobody in the scene, so the group was left as it is.`);
        return false;
    }

    const wanted = group.members.filter(avatar => !getLayoutEntry(layout, avatar).active);
    const muted = Array.isArray(group.disabled_members) ? group.disabled_members : [];

    if (wanted.length === muted.length && wanted.every(x => muted.includes(x))) {
        return false;
    }

    group.disabled_members = wanted;

    await editGroup(group.id, true, false);
    refreshGroupControlPanel();
    await eventSource.emit(event_types.GROUP_UPDATED);
    return true;
}

/**
 * Whether a layout can be applied at all. An empty one reads as unfinished
 * rather than as an instruction to open an empty scene, so it is left alone
 * and the group behaves as though no layout were selected.
 * @param {object|null} group
 * @param {Layout|null} layout
 * @returns {boolean}
 */
function isLayoutUsable(group, layout) {
    return Boolean(group && layout && (group.members ?? []).some(avatar =>
        getLayoutEntry(layout, avatar).active && getCharacterByAvatar(avatar)));
}

/**
 * Suppresses one member's greeting while a group chat is being created. Fires
 * once per member, before its message is built.
 *
 * Every greeting is suppressed, not just the ones the layout leaves out: the
 * loop walks group.members, so it can never produce a turn for a character
 * the layout wants but the group has lost, and a scene half-built by the loop
 * and half-repaired afterwards would come out in the wrong order.
 * openSceneFromLayout() builds the whole opening from the layout's turns.
 * @param {{input: string, output: string, character: object}} args
 */
export function applyLayoutGreeting(args) {
    if (!sideStageDropsGreeting(args)) {
        return;
    }

    // Whitespace rather than '': group-chats.js only takes the override when it
    // is truthy, so an empty string would leave the random pick standing. A
    // space survives that check, is trimmed to nothing immediately after, and a
    // member whose first message is empty is dropped from the chat.
    args.output = ' ';
}

/**
 * Whether SideStage drops this member's greeting from a new group chat: all of
 * them when a layout writes the opening, and with no layout a world group's
 * muted members (its mutes are its scene, where stock ST greets with everyone).
 * @param {{character: object}} args
 * @returns {boolean}
 */
function sideStageDropsGreeting(args) {
    const group = getCurrentGroup();
    const avatar = args?.character?.avatar;

    if (!avatar || !group) {
        return false;
    }

    if (isLayoutUsable(group, getActiveLayout(getCurrentGroup()?.id))) {
        return true;
    }

    return !!getGroupWorld(group.id) && !!group.disabled_members?.includes(avatar);
}

const QUIETED = Symbol('SideStage quieted');

/**
 * Skips other extensions' greeting pickers for the greetings SideStage drops.
 *
 * Extension-GroupGreetings in its Pick mode opens a "Pick a greeting" popup for
 * every member with group greetings when a group chat is created, and whatever
 * is picked would be thrown away. Its listener can't be told to stand down, so
 * each other listener of the event is wrapped to run only for greetings
 * SideStage keeps. Runs on APP_READY, once every extension has registered.
 */
export function quietOtherGreetingPickers() {
    const listeners = eventSource.events?.[event_types.CHARACTER_FIRST_MESSAGE_SELECTED];

    if (!Array.isArray(listeners)) {
        return;
    }

    listeners.forEach((listener, index) => {
        if (listener === applyLayoutGreeting || listener[QUIETED]) {
            return;
        }

        const quieted = function (args, ...rest) {
            return sideStageDropsGreeting(args) ? undefined : listener.call(this, args, ...rest);
        };
        quieted[QUIETED] = true;
        listeners[index] = quieted;
    });
}

/**
 * Builds a character's opening message the way getFirstCharacterMessage() does.
 * @param {object} character
 * @param {string} text
 * @returns {object|null}
 */
function buildGreetingMessage(character, text) {
    const mes = substituteParams(String(text ?? '').trim(), { name2Override: character.name });

    if (!mes) {
        return null;
    }

    return {
        is_user: false,
        is_system: false,
        name: character.name,
        send_date: getMessageTimeStamp(),
        original_avatar: character.avatar,
        extra: { gen_id: Date.now() * Math.random() * 1000000 },
        mes: mes,
        force_avatar: character.avatar !== 'none'
            ? getThumbnailUrl('avatar', character.avatar)
            : default_avatar,
    };
}

/**
 * Builds the layout's narrator line.
 *
 * A narrator-type message, which is what earns it the system avatar and, in
 * formatMessageHistoryItem(), a place in the prompt with no name in front of
 * it — scene text rather than a line of dialogue from someone. Not a system
 * message, so it does reach the prompt.
 * @param {Layout} layout
 * @returns {object|null}
 */
function buildNarratorMessage(layout) {
    const text = layout.narrator.trim();

    if (!text) {
        return null;
    }

    return {
        name: String(chat_metadata[NARRATOR_NAME_KEY] || t`Narrator`),
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(text),
        force_avatar: system_avatar,
        extra: {
            type: system_message_types.NARRATOR,
            gen_id: Date.now() * Math.random() * 1000000,
        },
    };
}

/**
 * Opens a fresh group chat as the selected layout describes it.
 *
 * Runs on GROUP_CHAT_CREATED, once the greeting loop has finished and left the
 * chat empty. Doing the whole opening here rather than steering the loop is
 * what puts the turns in the layout's order (the loop walks the member list)
 * and lets a card that joined since the chat was built take its turn too.
 * Everyone in the scene posts their turn; a blank turn posts nothing. The
 * mutes are applied first, so the scene and its turns land together.
 * @returns {Promise<void>}
 */
export async function openSceneFromLayout() {
    const group = getCurrentGroup();
    const layout = getActiveLayout(getCurrentGroup()?.id);

    if (!isLayoutUsable(group, layout)) {
        return;
    }

    try {
        await applyLayoutMutes();
    } catch (error) {
        console.error('[SideStage] Failed to apply the layout to the group', error);
        toastr.error(error?.message || t`Unknown error`, t`Failed to apply the layout`);
        return;
    }

    const messages = [buildNarratorMessage(layout)];

    for (const avatar of getLayoutOrder(group, layout)) {
        const character = getCharacterByAvatar(avatar);
        const entry = getLayoutEntry(layout, avatar);

        if (!character || !entry.active) {
            continue;
        }

        messages.push(buildGreetingMessage(character, getTurnText(entry)));
    }

    // Defensive: the loop suppressed everything, so both should already be
    // empty, and anything that isn't would otherwise be rendered twice.
    chat.splice(0, chat.length);
    $('#chat').find('.mes').remove();

    for (const message of messages.filter(x => x)) {
        chat.push(message);
        // Emitted the way the greeting loop emits its own, so extensions that
        // act on new messages — TTS, translation — see these too.
        await eventSource.emit(event_types.MESSAGE_RECEIVED, (chat.length - 1), 'first_message');
        addOneMessage(message);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, (chat.length - 1), 'first_message');
    }

    await saveChatConditional();
}

/**
 * Makes a specific group member take the next turn, bypassing the activation strategy.
 * @param {string} avatar Avatar file name of the character
 * @returns {Promise<void>}
 */
export async function forceTurn(avatar) {
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
 * Straight from chat_metadata rather than the textarea, because the Author's
 * Note extension fills that textarea from its own CHAT_CHANGED handler and
 * there is no ordering guarantee against ours — read the field on a chat
 * switch and it can still hold the previous chat's note.
 * @returns {string}
 */
function getChatAuthorsNote() {
    return String(chat_metadata[NOTE_PROMPT_KEY] ?? '');
}

/**
 * True while setChatAuthorsNote() is driving the field, so the input event it
 * fires is not mistaken for the user typing in it.
 */
let applyingNote = false;

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

    applyingNote = true;

    try {
        field.value = text;
        // Both listeners on this field are synchronous, so the guard is back
        // down before anything else can reach it.
        field.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
        applyingNote = false;
    }

    return true;
}

/**
 * The note the footer toggle applies: the selected layout's, falling back to
 * the group's. A layout's note is an override for one scene, so a blank one
 * means "use the group's" rather than "no note".
 * @returns {string}
 */
export function getEffectiveNote() {
    return getActiveLayout(getCurrentGroup()?.id)?.note || getActiveStage()?.note || '';
}

/**
 * Whether the footer's Author's Note toggle is on for this chat.
 *
 * Stored rather than derived. Comparing the chat's note against the roster's
 * used to stand in for this, but every way the roster note can legitimately
 * change out from under the chat — editing it in the drawer, switching to a
 * layout with its own note — broke that equality and silently flipped the
 * toggle off. Living in chat_metadata also means it is saved with the chat, so
 * it survives a refresh and comes back with the chat next session.
 * @returns {boolean}
 */
export function isNoteApplied() {
    return Boolean(chat_metadata[NOTE_APPLIED_KEY]);
}

/**
 * Applies the active roster's Author's Note to the current chat, or clears the
 * chat's note when switched off.
 * @param {boolean} shouldApply
 */
export function setNoteApplied(shouldApply) {
    const note = getEffectiveNote();

    if (shouldApply && !note) {
        toastr.info(t`This group has no Author's Note. Write one in the Character Editor's World section.`);
        refreshPanel();
        return;
    }

    if (!setChatAuthorsNote(shouldApply ? note : '')) {
        refreshPanel();
        return;
    }

    chat_metadata[NOTE_APPLIED_KEY] = shouldApply;
    // setChatAuthorsNote() only schedules a save when the note text itself
    // changed; switching off a chat whose note is already blank must still
    // persist the flag.
    saveMetadataDebounced();
    refreshPanel();
}

/**
 * Keeps the chat's Author's Note in step with the toggle.
 *
 * Runs on a chat change and after anything that moves the effective note — a
 * layout switch, an edit in the drawer. With the toggle on, the chat gets
 * whatever the roster now says; with it off, nothing is touched, so a note
 * typed by hand is left alone. A roster whose note has been emptied has
 * nothing left to apply, so the toggle goes off with it.
 */
export function syncNoteToChat() {
    if (!isNoteApplied()) {
        return;
    }

    const note = getEffectiveNote();

    if (!note) {
        chat_metadata[NOTE_APPLIED_KEY] = false;
        saveMetadataDebounced();
        return;
    }

    if (getChatAuthorsNote() !== note) {
        setChatAuthorsNote(note);
    }
}

/**
 * Turns the toggle off when the chat's note is typed over by hand.
 *
 * The stored flag means "this chat is holding the roster's note", and once the
 * text in the field is something else that is no longer true — leaving it on
 * would let the next layout switch quietly throw the hand-written note away.
 * Delegated from the document because the Author's Note field belongs to
 * another extension's drawer and may not exist yet when this runs.
 */
export function watchManualNoteEdits() {
    $(document).on('input', '#extension_floating_prompt', () => {
        if (applyingNote || !isNoteApplied() || getChatAuthorsNote() === getEffectiveNote()) {
            return;
        }

        chat_metadata[NOTE_APPLIED_KEY] = false;
        saveMetadataDebounced();
        refreshPanel();
    });
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
