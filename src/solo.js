/**
 * Solo chats with a world's card: the roster shows the world's cast, and inviting one of them carries the
 * chat on as a new chat of the world's group, instead of SillyTavern's "Convert to group" making a new group.
 */
import { characters, this_chid, chat, chat_metadata, getThumbnailUrl, getRequestHeaders, setActiveGroup, isGenerating, Generate, getCurrentChatId, system_message_types } from '../../../../../script.js';
import { selected_group, editGroup, openGroupById } from '../../../../group-chats.js';
import { humanizedDateTime } from '../../../../RossAscends-mods.js';
import { compressRequest } from '../../../../request-compression.js';
import { uuidv4, waitUntilCondition } from '../../../../utils.js';
import { t } from '../../../../i18n.js';
import { getCharacterByAvatar } from './util.js';
import { getWorldGroupOf, syncWorldGroup } from './worlds.js';
import { moveInOrOut } from './scene.js';
import { isNarrator } from './narrator.js';

/** Chat metadata naming the solo chat a group chat was carried on from. */
const SOLO_ORIGIN_KEY = 'sidestage_solo';

/**
 * The open solo chat's scene: its card and that card's world's group.
 * @returns {{character: object, group: object}|null} Null in a group chat, with no card open, or for a card in no world (or one whose group isn't made yet).
 */
export function getSoloScene() {
    if (selected_group || this_chid === undefined) {
        return null;
    }

    const character = characters[this_chid];
    const group = character ? getWorldGroupOf(character) : null;
    return group ? { character, group } : null;
}

/**
 * Gives the solo chat's own card the next reply: an ordinary send, so anything typed goes with it.
 * @returns {Promise<void>}
 */
export async function soloTurn() {
    try {
        await waitUntilCondition(() => !isGenerating(), 10000, 100);
    } catch {
        toastr.warning(t`Cannot force a turn while a reply is being generated.`);
        return;
    }

    await Generate('normal');
}

/**
 * The open solo chat's messages, as a group chat holds them: each of the card's replies names its speaker
 * and avatar, and gets its own generation id so it can be regenerated. The same conversion as
 * SillyTavern's convertSoloToGroupChat().
 * @param {object} character
 * @returns {object[]}
 */
function toGroupMessages(character) {
    const messages = chat.map(m => structuredClone(m));
    const genIdFirst = Date.now();

    messages.forEach((message, index) => {
        if (message.is_user || message.is_system || message.extra?.type === system_message_types.NARRATOR || message.force_avatar !== undefined) {
            return;
        }

        if (!message.extra || typeof message.extra !== 'object') {
            message.extra = {};
        }

        message.name = character.name;
        message.original_avatar = character.avatar;
        message.force_avatar = getThumbnailUrl('avatar', character.avatar);
        message.extra.gen_id = genIdFirst + index;
    });

    return messages;
}

/**
 * Invites a world member into the open solo chat: the chat is copied into a new chat of the world's group
 * (the solo chat stays as it was), with only its card in the scene, that chat is opened, and the guest
 * enters as the roster's first toggle brings anyone in (moveInOrOut()). Anything typed in the message box
 * is posted there, ahead of the entrance, and never to the solo chat.
 * @param {string} avatar The guest's avatar file name
 * @returns {Promise<boolean>} Whether the chat was carried on in the group
 */
export async function inviteToWorldGroup(avatar) {
    const scene = getSoloScene();
    const guest = getCharacterByAvatar(avatar);

    if (!scene || !guest || isNarrator(avatar) || avatar === scene.character.avatar) {
        return false;
    }

    try {
        await waitUntilCondition(() => !isGenerating(), 10000, 100);
    } catch {
        toastr.warning(t`Wait for the reply being generated to finish first.`);
        return false;
    }

    const { character, group } = scene;
    await syncWorldGroup(group.id);

    if (!group.members?.includes(character.avatar) || !group.members.includes(avatar)) {
        toastr.warning(t`${guest.name} isn't in the "${group.name}" group yet. Press ⟳ and try again.`);
        return false;
    }

    let name = humanizedDateTime();
    for (let n = 2; group.chats?.includes(name); n++) {
        name = `${humanizedDateTime()} (${n})`;
    }

    const metadata = structuredClone(chat_metadata);
    delete metadata.main_chat;
    metadata.integrity = uuidv4();
    metadata[SOLO_ORIGIN_KEY] = { avatar: character.avatar, chat: getCurrentChatId() };

    const header = { chat_metadata: metadata, user_name: 'unused', character_name: 'unused' };
    const response = await fetch('/api/chats/group/save', await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: name, chat: [header, ...toGroupMessages(character)] }),
    }));

    if (!response.ok) {
        throw new Error(t`SillyTavern could not save the group chat.`);
    }

    // Only the solo chat's card is in the scene; the guest is brought in once the chat is open, so the
    // entrance is played out there.
    group.chats = [...(Array.isArray(group.chats) ? group.chats : []), name];
    group.chat_id = name;
    group.disabled_members = group.members.filter(x => x !== character.avatar);
    await editGroup(group.id, true, false);

    // Held aside while the chat switches, then put back for moveInOrOut() to post first.
    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    const typed = String(textarea?.value ?? '');
    setTyped(textarea, '');
    setActiveGroup(group.id);

    if (!await openGroupById(group.id) || selected_group !== group.id) {
        setTyped(textarea, typed);
        toastr.info(t`The chat was carried on in the "${group.name}" group: open it there to bring ${guest.name} in.`);
        return false;
    }

    setTyped(textarea, typed);
    return moveInOrOut(avatar, true);
}

/**
 * Sets the message box's text the way typing would, so its height and anything listening follow.
 * @param {HTMLTextAreaElement|null} textarea
 * @param {string} text
 */
function setTyped(textarea, text) {
    if (!textarea || textarea.value === text) {
        return;
    }

    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
