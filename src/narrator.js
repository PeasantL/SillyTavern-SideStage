/**
 * The narrator: a card SideStage makes and keeps, muted, in every world's group, so the OOC / Morality / Scene
 * asides have someone to answer them as a turn of their own (and a swipe asks them again). Marked in the card as
 * `data.extensions.sidestage.narrator`; it never shows in the character list, the roster or the image viewer, and
 * the Character Editor leaves it out of its list too. Its portrait is the Character Editor's icon (narrator.png).
 */
import { characters, entitiesFilter, getCharacters, getRequestHeaders, printCharactersDebounced } from '../../../../../script.js';
import { t } from '../../../../i18n.js';

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
