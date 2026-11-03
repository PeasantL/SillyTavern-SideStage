/**
 * The narrator: a card SideStage makes and keeps, muted, in every world's group, so the OOC / Morality / Scene
 * asides have someone to answer them as a turn of their own (and a swipe asks them again). Marked in the card as
 * `data.extensions.sidestage.narrator`; it never shows in the character list, the roster or the image viewer, and
 * the Character Editor leaves it out of its list too. Its portrait is the Character Editor's icon (narrator.png).
 */
import { characters, entitiesFilter, getCharacters, getRequestHeaders, printCharactersDebounced, eventSource, event_types, substituteParams, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../../script.js';
import { t } from '../../../../i18n.js';
import { getSettings } from './settings.js';
import { getCharacterByAvatar, getCurrentGroup } from './util.js';

const NARRATOR_NAME = 'Narrator';
const NARRATOR_DESCRIPTION = [
    '{{char}} is the narrator of this roleplay, not a character in it. {{char}} describes the scene, the world and',
    'the consequences of what the characters do, and answers out-of-character questions about the story plainly.',
    '{{char}} never speaks or acts for {{user}}.',
].join(' ');

/** The narrator's portrait, shipped with SideStage. */
const AVATAR_URL = new URL('../narrator.png', import.meta.url);
/**
 * Raised when narrator.png changes, so a narrator card made with an older one
 * (or none) gets the new one once. Kept in the card as `sidestage.avatar`.
 */
const AVATAR_VERSION = 1;

/** Extension prompt that gives the aside answerer, for their turn, the descriptions of everyone in the scene. */
const CAST_PROMPT_KEY = 'sidestage_cast';

/** Key under ST's entity filter functions that keeps the narrator out of the character list. */
const LIST_FILTER_KEY = 'sidestageNarrator';

/** @returns {boolean} Whether a card is SideStage's narrator. */
export function isNarratorCard(character) {
    return character?.data?.extensions?.sidestage?.narrator === true;
}

/** @returns {string|null} The narrator card's avatar file name, or null while there is none. */
export function getNarratorAvatar() {
    return characters.find(isNarratorCard)?.avatar ?? null;
}

/** @returns {boolean} Whether an avatar file name is the narrator's. */
export function isNarrator(avatar) {
    return !!avatar && avatar === getNarratorAvatar();
}

/**
 * Who answers the asides in the open group: the member named in the "Answered
 * by" setting (matched without regard to case), or else SideStage's own
 * narrator card when the group has it, as every world's group does. Muted
 * members count: they answer asides but not rounds. The layout's opening and
 * the roster's entrance and exit lines are posted as them too, so every
 * narrator line in the chat looks the same.
 * @returns {string|null} Their avatar, or null outside a group, with the setting blank, or with neither
 */
export function getOocNarrator() {
    const name = String(getSettings().oocNarrator ?? '').trim().toLowerCase();
    const group = getCurrentGroup();

    if (!name || !Array.isArray(group?.members)) {
        return null;
    }

    const named = group.members.find(avatar => getCharacterByAvatar(avatar)?.name?.trim().toLowerCase() === name);
    return named ?? group.members.find(isNarrator) ?? null;
}

/**
 * The descriptions of everyone in the open group's scene (unmuted, and not the
 * answerer), for the answerer's prompt. A world group swaps cards, so their own
 * card is all a turn would otherwise have of anyone.
 * @param {string} answerer Avatar of who is answering
 * @returns {string} Blank when nobody in the scene has a description
 */
function buildCastPrompt(answerer) {
    const group = getCurrentGroup();
    const muted = Array.isArray(group?.disabled_members) ? group.disabled_members : [];
    const parts = (group?.members ?? [])
        .filter(avatar => avatar !== answerer && !muted.includes(avatar))
        .map(getCharacterByAvatar)
        .filter(character => character && !isNarratorCard(character))
        .map(character => {
            const description = substituteParams(String(character.description ?? '').trim(), { name2Override: character.name });
            return description ? `${character.name}:\n${description}` : '';
        })
        .filter(Boolean);

    return parts.length ? `[The characters in the scene]\n\n${parts.join('\n\n')}` : '';
}

/**
 * Sets or clears the cast prompt as each group member is drafted: the aside
 * answerer's turns (OOC, Morality, Scene, and swipes of them) get it, nobody
 * else's do.
 * @param {number} chId Index into characters of who is about to speak
 */
function onMemberDrafted(chId) {
    const answerer = getOocNarrator();
    const text = answerer && characters[chId]?.avatar === answerer ? buildCastPrompt(answerer) : '';
    setExtensionPrompt(CAST_PROMPT_KEY, text, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}

/** Clears the cast prompt, so it never outlives the turn it was set for. */
function clearCastPrompt() {
    setExtensionPrompt(CAST_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}

/** Gives the aside answerer the scene's descriptions on each of their turns. */
export function watchNarratorTurns() {
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onMemberDrafted);

    for (const type of [event_types.GROUP_WRAPPER_FINISHED, event_types.GENERATION_STOPPED, event_types.CHAT_CHANGED]) {
        if (type) {
            eventSource.on(type, clearCastPrompt);
        }
    }
}

/** @returns {Promise<File>} narrator.png, ready to upload as a card's image. */
async function getAvatarFile() {
    const response = await fetch(AVATAR_URL);

    if (!response.ok) {
        throw new Error(t`Could not load the narrator's portrait.`);
    }

    return new File([await response.blob()], 'narrator.png', { type: 'image/png' });
}

/**
 * Gives an existing narrator card the current portrait and records which one
 * it has, so this happens once per AVATAR_VERSION.
 * @param {string} avatar The narrator card's file name
 * @returns {Promise<void>}
 */
async function updateNarratorAvatar(avatar) {
    const form = new FormData();
    form.append('avatar', await getAvatarFile());
    form.append('avatar_url', avatar);

    const upload = await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: form,
    });

    if (!upload.ok) {
        throw new Error(t`SillyTavern could not change the narrator's portrait.`);
    }

    const stamp = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar, data: { extensions: { sidestage: { avatar: AVATAR_VERSION } } } }),
    });

    if (!stamp.ok) {
        throw new Error(t`SillyTavern could not save the narrator card.`);
    }
}

let creating = null;

/**
 * Makes the narrator card when there is none (the first start, or it was deleted), or brings an existing one's
 * portrait up to date, and reloads ST's characters so it is there to sync into the world groups.
 * @returns {Promise<void>}
 */
export function ensureNarratorCard() {
    const existing = characters.find(isNarratorCard);

    if (creating || (existing && existing.data.extensions.sidestage.avatar === AVATAR_VERSION)) {
        return creating ?? Promise.resolve();
    }

    creating = (async () => {
        try {
            if (existing) {
                await updateNarratorAvatar(existing.avatar);
            } else {
                const form = new FormData();
                form.append('avatar', await getAvatarFile());
                form.append('ch_name', NARRATOR_NAME);
                form.append('description', NARRATOR_DESCRIPTION);
                form.append('extensions', JSON.stringify({ sidestage: { narrator: true, avatar: AVATAR_VERSION } }));

                const response = await fetch('/api/characters/create', {
                    method: 'POST',
                    headers: getRequestHeaders({ omitContentType: true }),
                    body: form,
                });

                if (!response.ok) {
                    throw new Error(t`SillyTavern could not create the narrator card.`);
                }
            }

            await getCharacters();
        } catch (error) {
            console.error('[SideStage] Could not create the narrator card', error);
            toastr.error(error?.message || t`Unknown error`, t`Narrator`);
        } finally {
            creating = null;
        }
    })();

    return creating;
}

/**
 * Keeps the narrator out of ST's character list (and its search): one more function in the list's own filter
 * chain, which runs on every render.
 */
export function hideNarratorFromList() {
    entitiesFilter.filterFunctions[LIST_FILTER_KEY] = entities =>
        entities.filter(entity => !(entity.type === 'character' && isNarratorCard(entity.item)));
    // The list may have been printed before SideStage loaded.
    printCharactersDebounced();
}
