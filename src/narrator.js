/**
 * The narrator: a card SideStage makes and keeps, muted, in every world's group, so the OOC / Morality / Scene
 * asides have someone to answer them as a turn of their own (and a swipe asks them again). Marked in the card as
 * `data.extensions.sidestage.narrator`; it never shows in the character list, the roster or the image viewer, and
 * the Character Editor leaves it out of its list too. Its portrait is the Character Editor's icon (narrator.png).
 */
import { characters, entitiesFilter, getCharacters, getRequestHeaders, printCharactersDebounced, eventSource, event_types, substituteParams, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, chat, this_chid, getThumbnailUrl, saveChatConditional, isGenerating } from '../../../../../script.js';
import { waitUntilCondition } from '../../../../utils.js';
import { groups, selected_group } from '../../../../group-chats.js';
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

/** Extension prompt that tells the model, in a solo chat, that this reply is the narrator's. */
const SOLO_PROMPT_KEY = 'sidestage_solo_narrator';
/** On a solo chat's message: the avatar of the narrator who answered it, so a swipe asks them again. */
const SOLO_NARRATOR_KEY = 'sidestage_narrator';

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

/**
 * Who answers the asides in a solo chat: the card named in the "Answered by"
 * setting, or else SideStage's narrator card. Not the chat's own card: named
 * that, it answers them itself, as an ordinary reply.
 * @returns {string|null} Their avatar, or null in a group, with the setting blank, or with neither
 */
export function getSoloNarrator() {
    const name = String(getSettings().oocNarrator ?? '').trim().toLowerCase();
    const open = this_chid === undefined ? null : characters[this_chid];

    if (!name || selected_group || !open || open.name?.trim().toLowerCase() === name) {
        return null;
    }

    const named = characters.find(character => character !== open && character.name?.trim().toLowerCase() === name);
    return (named ?? characters.find(isNarratorCard))?.avatar ?? null;
}

/**
 * The solo chat's narrator turn in progress: who answers, and the first
 * message index that is theirs. Their reply is generated with the chat's own
 * card (a solo chat has no other) and told it is the narrator's; then it is
 * posted under the narrator's name and portrait.
 * @type {{answerer: string, from: number}|null}
 */
let soloTurn = null;

/** @param {string} answerer */
function buildSoloPrompt(answerer) {
    const narrator = getCharacterByAvatar(answerer);
    const open = this_chid === undefined ? null : characters[this_chid];

    if (!narrator || !open) {
        return '';
    }

    const description = substituteParams(String(narrator.description ?? '').trim(), { name2Override: narrator.name });
    const head = `[This reply is ${narrator.name}'s, not ${open.name}'s: write only ${narrator.name}'s answer, out of character.`;
    return description ? `${head}\nAbout ${narrator.name}: ${description}]` : `${head}]`;
}

/**
 * Puts a solo chat's message under the narrator's name and portrait, in the
 * chat and on screen, and marks it as theirs.
 * @param {number} id
 */
function relabel(id) {
    const message = chat[id];
    const narrator = getCharacterByAvatar(soloTurn?.answerer);

    if (!message || message.is_user || message.is_system || !narrator || id < soloTurn.from) {
        return;
    }

    message.name = narrator.name;
    message.original_avatar = narrator.avatar;
    message.force_avatar = getThumbnailUrl('avatar', narrator.avatar);
    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    message.extra[SOLO_NARRATOR_KEY] = narrator.avatar;

    const element = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (element) {
        element.setAttribute('ch_name', narrator.name);
        const nameText = element.querySelector('.name_text');
        if (nameText) {
            nameText.textContent = narrator.name;
        }
        element.querySelector('.avatar img')?.setAttribute('src', message.force_avatar);
    }
}

/** Starts a solo chat's narrator turn: the next reply is theirs. */
export function beginSoloNarratorTurn(answerer) {
    soloTurn = { answerer, from: chat.length };
}

/** Ends it: the prompt goes, and whatever they posted is put under their name. */
export async function endSoloNarratorTurn() {
    if (!soloTurn) {
        return;
    }

    setExtensionPrompt(SOLO_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
    for (let id = soloTurn.from; id < chat.length; id++) {
        relabel(id);
    }
    soloTurn = null;
    await saveChatConditional();
}

/**
 * As a solo chat's generation starts: a narrator turn gets its prompt, and so
 * does a swipe (or continue) of a reply the narrator gave.
 */
function onSoloGenerationStarted(type, _params, dryRun) {
    if (dryRun || selected_group) {
        return;
    }

    if (!soloTurn && ['swipe', 'continue', 'regenerate'].includes(type)) {
        const last = chat[chat.length - 1];
        const answerer = last && !last.is_user ? last.extra?.[SOLO_NARRATOR_KEY] : null;

        if (answerer && getCharacterByAvatar(answerer)) {
            soloTurn = { answerer, from: chat.length - 1 };
        }
    }

    if (soloTurn) {
        setExtensionPrompt(SOLO_PROMPT_KEY, buildSoloPrompt(soloTurn.answerer), extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    }
}

/** Gives the aside answerer the scene's descriptions on each of their turns, and runs solo chats' narrator turns. */
export function watchNarratorTurns() {
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onMemberDrafted);

    for (const type of [event_types.GROUP_WRAPPER_FINISHED, event_types.GENERATION_STOPPED, event_types.CHAT_CHANGED]) {
        if (type) {
            eventSource.on(type, clearCastPrompt);
        }
    }

    eventSource.on(event_types.GENERATION_STARTED, onSoloGenerationStarted);
    // While their reply streams in, and once it lands, it shows as theirs.
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => soloTurn && relabel(chat.length - 1));
    eventSource.on(event_types.MESSAGE_RECEIVED, id => soloTurn && relabel(Number(id)));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, id => soloTurn && relabel(Number(id)));

    // The reply may be saved just after the generation says it ended: wait for SillyTavern to let go first.
    const endWhenDone = () => {
        if (soloTurn) {
            waitUntilCondition(() => !isGenerating(), 10 * 60 * 1000, 100).catch(() => {}).finally(endSoloNarratorTurn);
        }
    };
    for (const type of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
        if (type) {
            eventSource.on(type, endWhenDone);
        }
    }
    eventSource.on(event_types.CHAT_CHANGED, () => {
        soloTurn = null;
        setExtensionPrompt(SOLO_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
    });
}

/** @returns {boolean} Whether an <img> shows the narrator card's portrait (its thumbnail or the card itself). */
function showsNarrator(img, avatar) {
    const src = img.getAttribute('src') || '';
    try {
        const url = new URL(src, location.href);
        return url.searchParams.get('file') === avatar || decodeURIComponent(url.pathname).endsWith(`/${avatar}`);
    } catch {
        return false;
    }
}

/** @param {Element|null} element @param {string} text */
function setText(element, text) {
    if (element && element.textContent !== text) {
        element.textContent = text;
    }
}

/**
 * Takes the narrator out of what SillyTavern shows of a group: the list's
 * member names and count, and the portrait collages (the list, the group's own
 * panel, recent chats). It is still a member, muted, so it can answer the
 * asides; it is only not shown.
 */
function hideNarratorInGroupViews() {
    const avatar = getNarratorAvatar();

    if (!avatar) {
        return;
    }

    for (const block of document.querySelectorAll('.group_select[data-grid]')) {
        const group = groups.find(x => String(x.id) === block.getAttribute('data-grid'));

        if (!Array.isArray(group?.members) || !group.members.includes(avatar)) {
            continue;
        }

        const names = group.members
            .filter(member => member !== avatar)
            .map(member => characters.find(x => x.avatar === member || x.name === member)?.name)
            .filter(Boolean);
        setText(block.querySelector('.group_select_counter'), `${names.length} ${names.length !== 1 ? t`characters` : t`character`}`);
        setText(block.querySelector('.group_select_block_list'), names.join(', '));
    }

    for (const collage of document.querySelectorAll('.avatar_collage')) {
        if (collage.closest('.template_element')) {
            continue;
        }

        const images = [...collage.querySelectorAll('img')];
        const kept = images.filter(img => !showsNarrator(img, avatar)).map(img => img.getAttribute('src'));

        if (kept.length === images.length || !kept.length) {
            continue;
        }

        const fresh = document.querySelector(`#group_avatars_template .collage_${kept.length}`)?.cloneNode(true);

        if (!(fresh instanceof HTMLElement)) {
            continue;
        }

        kept.forEach((src, index) => fresh.querySelector(`.img_${index + 1}`)?.setAttribute('src', src));
        if (collage.getAttribute('title')) {
            fresh.setAttribute('title', collage.getAttribute('title'));
        }
        collage.replaceWith(fresh);
    }
}

/** Keeps the narrator's style rule up to date: its row in the group panel's member list is hidden. */
function updateNarratorStyle() {
    const avatar = getNarratorAvatar();
    let style = document.getElementById('sidestage-narrator-style');

    if (!style) {
        style = document.createElement('style');
        style.id = 'sidestage-narrator-style';
        document.head.append(style);
    }

    const css = avatar
        ? `.group_member:has(.avatar img[title="${avatar.replace(/["\\]/g, '\\$&')}"]) { display: none !important; }`
        : '';
    if (style.textContent !== css) {
        style.textContent = css;
    }
}

/**
 * Keeps the narrator out of sight in SillyTavern's group views as they are
 * drawn: one look over the page after anything in it changes.
 */
export function hideNarratorInGroups() {
    let queued = false;
    const pass = () => {
        queued = false;
        updateNarratorStyle();
        hideNarratorInGroupViews();
    };

    new MutationObserver(() => {
        if (!queued) {
            queued = true;
            requestAnimationFrame(pass);
        }
    }).observe(document.body, { childList: true, subtree: true });
    pass();
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
