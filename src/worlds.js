/**
 * Worlds and their groups: which group is a world's, its stage and selected layout, syncing members,
 * and catching up with what the Character Editor changed (on ⟳, at start, and on coming back to the tab).
 */
import { eventSource, event_types, characters, isGenerating, default_avatar, getCharacters, getRequestHeaders } from '../../../../../script.js';
import { groups, editGroup, group_generation_mode, DEFAULT_AUTO_MODE_DELAY } from '../../../../group-chats.js';
import { saveWorldInfo } from '../../../../world-info.js';
import * as worldInfo from '../../../../world-info.js';
import { waitUntilCondition } from '../../../../utils.js';
import { t } from '../../../../i18n.js';
import { getLayoutEntry, mergeStage, normalizeStage, stageRev } from './stage.js';
import { debounce, getCurrentGroup } from './util.js';
import { refreshGroupControlPanel } from './scene.js';
import { refreshPanel } from './panel.js';
import { renderSettings } from './drawer.js';
import { applyLock } from './lock.js';
import { ensureNarratorCard, getNarratorAvatar } from './narrator.js';

/**
 * The stage of one group, kept in its world's lorebook.
 * @param {string} [groupId]
 * @returns {Stage|null} Null for no group, a group not tied to a world, or while that isn't known yet.
 */
export function getStage(groupId) {
    const world = groupId ? getGroupWorld(groupId) : '';
    return world ? worldStages.get(world) ?? null : null;
}

/** @returns {Stage|null} The stage of the open group chat. */
export function getActiveStage() {
    return getStage(getCurrentGroup()?.id);
}

/** @returns {object[]} The groups tied to a world: the only ones with layouts and a note. */
export function getWorldGroups() {
    return groups.filter(x => getGroupWorld(x.id));
}

/** Field of a world's group (in ST's group file) naming its selected layout. */
export const GROUP_LAYOUT_KEY = 'sidestage_layout';

/**
 * @param {object|null|undefined} group
 * @returns {string} Id of the layout selected in the panel footer for this group, or '' for none.
 */
function getSelectedLayoutId(group) {
    return String(group?.[GROUP_LAYOUT_KEY] ?? '');
}

/**
 * The group's selected layout. Picking one is a choice made in SillyTavern, so
 * it is kept in the group's file (ST saves the whole group object) rather than
 * in the world's lorebook, which then changes only when layouts are edited.
 * A selected layout deleted since (in the Character Editor) counts as none.
 * @param {string} [groupId]
 * @returns {Layout|null}
 */
export function getActiveLayout(groupId) {
    const id = getSelectedLayoutId(groups.find(x => x.id === groupId));
    return (id && getStage(groupId)?.layouts.find(x => x.id === id)) || null;
}


/**
 * Every world has its own group.
 *
 * A world is a lorebook carrying SideStage's key (extensions.sidestage; an
 * empty object until its group is made), as the Character Editor marks it.
 * Its cast is every card that links it
 * (data.extensions.world). SideStage creates a group for each world that has a
 * cast, named after it, and keeps it so: its members are exactly the world's
 * cards (they join and leave with the world), who is in the scene is who is
 * unmuted, and its name follows the world's. A world whose group is deleted
 * gets a new one; a group whose world is gone becomes an ordinary group, as
 * SideStage never deletes a group (that would delete its chats).
 *
 * Which group is the world's, and the group's stage, live in the lorebook under
 * extensions.sidestage ({group, note, layouts, rev}), so they travel
 * with the world and survive the editor renaming it; the group file only ever
 * holds ST's own fields.
 *
 * Cards changed outside ST (the editor) reach ST's character list on a reload;
 * the sync button reloads it without one.
 *
 * The Character Editor edits the layouts too. Every save raises the stage's
 * `rev`; one that finds the file's `rev` moved on since it was read merges what
 * changed here into the file's version instead of writing over it.
 */
const WORLD_KEY = 'sidestage';
const WORLD_SAVE_DELAY = 1000;

/** Group id -> the name of its world's lorebook, or '' for a group not tied to one. */
const groupWorlds = new Map();
/** World lorebook name -> the stage kept in it, for worlds tied to a group. */
const worldStages = new Map();
/** World lorebook name -> id of its group ('' while it has none), for every world any card links. */
export const worldLorebooks = new Map();
/** World lorebook name -> the group id its file named when last read, even one since deleted. */
const recordedGroups = new Map();
/** World lorebook name -> a copy of its stage as last read from or written to the file: what changed here since. */
const worldBases = new Map();
/** Whether resolveWorlds() has run, so a group missing from groupWorlds is known to have no world. */
let worldsResolved = false;

/**
 * The world a group is tied to.
 * @param {string} groupId
 * @returns {string|null} The world's lorebook name, '' for none, or null while that isn't known yet.
 */
export function getGroupWorld(groupId) {
    if (groupWorlds.has(groupId)) {
        return groupWorlds.get(groupId);
    }

    return worldsResolved ? '' : null;
}

/** @returns {string} The lorebook a character links, or ''. */
function getCharacterWorld(character) {
    return String(character?.data?.extensions?.world ?? '');
}

/**
 * The cards of a world, in character-list order.
 * @param {string} world
 * @returns {string[]} Avatar file names
 */
function getWorldCast(world) {
    return characters.filter(x => world && getCharacterWorld(x) === world).map(x => x.avatar);
}

/**
 * Reads a lorebook straight from the server. Deliberately not loadWorldInfo():
 * ST caches lorebooks for the whole session, and a world edited in the
 * Character Editor since then would be read stale — and then written back
 * stale over the editor's changes.
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function fetchWorld(name) {
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name }),
    });

    if (!response.ok) {
        return null;
    }

    const data = await response.json();
    return data && typeof data === 'object' && data.entries ? data : null;
}

/** @returns {boolean} Whether a lorebook is a world: it carries SideStage's key. */
function isWorldLorebook(data) {
    const stage = data?.extensions?.[WORLD_KEY];
    return Boolean(stage && typeof stage === 'object');
}

/**
 * Writes a world's stage into its lorebook. Re-reads the file first and
 * replaces only extensions.sidestage, so entries and anything else edited
 * elsewhere in the meantime are kept; a stage saved there since it was read
 * (by the Character Editor) is merged with this one rather than overwritten.
 * A world SideStage holds no stage for is left alone: the key is what makes
 * the lorebook a world, so it is never removed.
 * @param {string} world
 */
async function writeWorldStage(world) {
    const stage = worldStages.get(world);

    if (!stage) {
        return;
    }

    const data = await fetchWorld(world);

    if (!data) {
        throw new Error(t`The lorebook "${world}" could not be read.`);
    }

    const extensions = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    const file = extensions[WORLD_KEY] && typeof extensions[WORLD_KEY] === 'object' ? extensions[WORLD_KEY] : null;
    const base = worldBases.get(world);
    const merge = Boolean(base && file && stageRev(file) !== stageRev(base));

    if (merge) {
        mergeStage(stage, base, file);
    }

    stage.rev = Math.max(stageRev(stage), stageRev(file)) + 1;
    const written = structuredClone(stage);
    extensions[WORLD_KEY] = written;
    data.extensions = extensions;

    if (merge) {
        renderSettings();
        refreshPanel();
    }

    await saveWorldInfo(world, data, true);
    worldBases.set(world, structuredClone(written));
}

/**
 * Takes the world's stage from its file when it was saved elsewhere (layouts
 * edited in the Character Editor) since SideStage read it. A save waiting to
 * go is written first, which merges the two.
 * @param {string} world
 * @param {object} [given] The stage in the file, when the caller has just read it
 */
export async function pullWorldStage(world, given) {
    if (pendingWorldSaves.has(world)) {
        await flushWorldSave(world);
        return;
    }

    const stage = worldStages.get(world);
    const base = worldBases.get(world);
    const file = !stage || !base ? null : given ?? (await fetchWorld(world))?.extensions?.[WORLD_KEY];

    if (!file || typeof file !== 'object' || stageRev(file) === stageRev(base) || String(file.group ?? '') !== stage.group) {
        return;
    }

    mergeStage(stage, base, file);
    worldBases.set(world, structuredClone(stage));
    renderSettings();
    refreshPanel();
}

/** World name -> pending save timer. */
const pendingWorldSaves = new Map();

/** Saves a world's stage shortly, so typing in the drawer doesn't write the lorebook on every key. */
function saveWorldStageDebounced(world) {
    clearTimeout(pendingWorldSaves.get(world));
    pendingWorldSaves.set(world, setTimeout(() => flushWorldSave(world), WORLD_SAVE_DELAY));
}

/** Writes a world's pending save now. */
async function flushWorldSave(world) {
    if (!pendingWorldSaves.has(world)) {
        return;
    }

    clearTimeout(pendingWorldSaves.get(world));
    pendingWorldSaves.delete(world);

    try {
        await writeWorldStage(world);
    } catch (error) {
        console.error('[SideStage] Could not save the stage to the world', error);
        toastr.error(error?.message || t`Unknown error`, t`Could not save to the world "${world}"`);
    }
}

/** Writes every pending world save now, so nothing in memory is newer than the files. */
async function flushWorldSaves() {
    await Promise.all([...pendingWorldSaves.keys()].map(flushWorldSave));
}

/**
 * Every lorebook's `extensions`, by file name, from SillyTavern's World Info
 * list: one request, without the entries, and all that finding the worlds and
 * their stages needs. Entries are read only before a write (writeWorldStage()).
 * @returns {Promise<Map<string, object>>}
 */
async function fetchLorebookExtensions() {
    const response = await fetch('/api/worldinfo/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error(t`SillyTavern could not list the lorebooks.`);
    }

    const list = await response.json();
    return new Map((Array.isArray(list) ? list : [])
        .filter(x => x && typeof x.file_id === 'string')
        .map(x => [x.file_id, x.extensions && typeof x.extensions === 'object' ? x.extensions : {}]));
}

/**
 * Works out which group each world is tied to, from the lorebooks the cards
 * link. Only those can be worlds with a cast; a world nobody links has no
 * cast and so no group to fill.
 */
async function resolveWorlds() {
    await flushWorldSaves();

    const names = [...new Set(characters.map(getCharacterWorld).filter(Boolean))];
    const extensions = await fetchLorebookExtensions();
    const stages = new Map();
    const lorebooks = new Map();
    const owners = new Map();
    const recorded = new Map();
    const bases = new Map();

    for (const name of names) {
        const data = extensions.has(name) ? { extensions: extensions.get(name) } : null;

        if (!isWorldLorebook(data)) {
            continue;
        }

        const stage = data.extensions[WORLD_KEY];
        const groupId = stage && typeof stage === 'object' ? String(stage.group ?? '') : '';
        // A world whose group has been deleted keeps its layouts for the group
        // made to replace it, but counts as having no group.
        const owned = groupId && groups.some(x => x.id === groupId) && !owners.has(groupId);

        lorebooks.set(name, owned ? groupId : '');
        recorded.set(name, groupId);

        if (owned) {
            await takeSelectedLayout(groups.find(x => x.id === groupId), stage);
            owners.set(groupId, name);
            stages.set(name, normalizeStage(stage));
            bases.set(name, structuredClone(stage));
        }
    }

    worldStages.clear();
    stages.forEach((stage, name) => worldStages.set(name, stage));
    worldLorebooks.clear();
    lorebooks.forEach((owner, name) => worldLorebooks.set(name, owner));
    recordedGroups.clear();
    recorded.forEach((groupId, name) => recordedGroups.set(name, groupId));
    worldBases.clear();
    bases.forEach((stage, name) => worldBases.set(name, stage));
    groupWorlds.clear();

    for (const group of groups) {
        groupWorlds.set(group.id, owners.get(group.id) ?? '');
    }

    worldsResolved = true;
}

/**
 * Moves the selected layout of a stage saved before it was the group's
 * (`activeLayoutId` in the lorebook) onto the group, once. The lorebook loses
 * it on its next save (normalizeStage()).
 * @param {object|undefined} group
 * @param {object} stage The stage as read from the lorebook
 */
async function takeSelectedLayout(group, stage) {
    const id = typeof stage.activeLayoutId === 'string' ? stage.activeLayoutId : '';

    if (!group || GROUP_LAYOUT_KEY in group || !id || !Array.isArray(stage.layouts) || !stage.layouts.some(x => x?.id === id)) {
        return;
    }

    group[GROUP_LAYOUT_KEY] = id;
    await editGroup(group.id, true, false);
}

/**
 * Brings a world's group in step with its world: cards of the world that
 * aren't members join (muted, unless the selected layout puts them in the
 * scene), members that aren't in the world leave, and the name follows the
 * world's (renamed in the Character Editor). The narrator is a member too,
 * always muted: it answers the asides as a forced turn, never a round.
 * @param {string} groupId
 * @returns {Promise<boolean>} Whether the group was changed
 */
export async function syncWorldGroup(groupId) {
    const world = getGroupWorld(groupId);
    const group = groups.find(x => x.id === groupId);

    if (!world || !group) {
        return false;
    }

    const cast = getWorldCast(world);

    // Never empty a group: with no cast at all, either the characters haven't
    // loaded or every card left the world, and neither is worth a wiped group.
    if (!cast.length) {
        return false;
    }

    const narrator = getNarratorAvatar();
    const wanted = narrator ? [...cast, narrator] : cast;
    const members = Array.isArray(group.members) ? group.members : [];
    const muted = Array.isArray(group.disabled_members) ? group.disabled_members : [];
    const kept = members.filter(avatar => wanted.includes(avatar));
    const joined = wanted.filter(avatar => !kept.includes(avatar));
    const nextMembers = [...kept, ...joined];
    const layout = getActiveLayout(groupId);
    const nextMuted = [
        ...muted.filter(avatar => kept.includes(avatar) && avatar !== narrator),
        ...joined.filter(avatar => avatar !== narrator && !(layout && getLayoutEntry(layout, avatar).active)),
        ...(narrator ? [narrator] : []),
    ];

    const sameMembers = nextMembers.length === members.length && nextMembers.every((x, i) => members[i] === x);
    const sameMuted = nextMuted.length === muted.length && nextMuted.every(x => muted.includes(x));

    if (sameMembers && sameMuted && group.name === world) {
        return false;
    }

    group.members = nextMembers;
    group.disabled_members = nextMuted;
    group.name = world;

    await editGroup(groupId, true, false);
    refreshGroupControlPanel();
    await eventSource.emit(event_types.GROUP_UPDATED);
    return true;
}

/** Syncs every world's group. */
async function syncWorldGroups() {
    for (const [groupId, world] of groupWorlds) {
        if (world) {
            await syncWorldGroup(groupId);
        }
    }
}

let refreshingWorlds = null;

/**
 * Re-reads which groups belong to which worlds, creates the groups worlds
 * are missing and brings them all in step. With `reload`, first reloads ST's characters and groups from disk, so
 * cards changed in the Character Editor since ST loaded are seen without
 * reloading the page.
 * @param {{reload?: boolean}} [options]
 */
export function refreshWorlds({ reload = false } = {}) {
    if (refreshingWorlds) {
        return refreshingWorlds;
    }

    refreshingWorlds = (async () => {
        try {
            if (reload) {
                await waitUntilCondition(() => !isGenerating(), 30000, 200);
                await getCharacters();
                await refreshCachedLorebooks();
            }

            await ensureNarratorCard();
            await resolveWorlds();
            await ensureWorldGroups();
            await syncWorldGroups();
        } catch (error) {
            console.error('[SideStage] Could not sync the world groups', error);
            toastr.error(error?.message || t`Unknown error`, t`Could not sync the world groups`);
        } finally {
            refreshingWorlds = null;
            renderSettings();
            refreshPanel();
            applyLock();
        }
    })();

    return refreshingWorlds;
}

/** Syncs the world groups shortly after a card changed in ST, once per burst of changes. */
export const syncWorldGroupsSoon = debounce(() => {
    if (worldsResolved && !refreshingWorlds) {
        syncWorldGroups().catch(error => console.error('[SideStage] Could not sync the world groups', error));
    }
}, 500);

/**
 * Creates a world's group, with the world's whole cast in the scene, and
 * records it in the world's lorebook (keeping layouts the world kept from a
 * deleted group). Members' cards are joined (Append) rather than swapped, so
 * the scene's card text is the unmuted members'.
 * @param {string} world
 * @param {object} data The world's lorebook, freshly read
 */
async function createWorldGroup(world, data) {
    const narrator = getNarratorAvatar();
    const response = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            name: world,
            members: [...getWorldCast(world), ...(narrator ? [narrator] : [])],
            disabled_members: narrator ? [narrator] : [],
            avatar_url: default_avatar,
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: group_generation_mode.APPEND,
            auto_mode_delay: DEFAULT_AUTO_MODE_DELAY,
        }),
    });

    if (!response.ok) {
        throw new Error(t`SillyTavern could not create a group for the world "${world}".`);
    }

    const created = await response.json();
    const kept = data.extensions[WORLD_KEY];
    const stage = normalizeStage(kept && typeof kept === 'object' ? kept : {});
    stage.group = String(created.id);

    worldStages.set(world, stage);
    worldBases.set(world, structuredClone(stage));
    worldLorebooks.set(world, stage.group);
    recordedGroups.set(world, stage.group);
    groupWorlds.set(stage.group, world);
    await writeWorldStage(world);
}

/**
 * Creates a group for every world with a cast and none of its own: a new
 * world, or one whose group was deleted.
 */
async function ensureWorldGroups() {
    const made = [];

    for (const [world, owner] of worldLorebooks) {
        if (owner || !getWorldCast(world).length) {
            continue;
        }

        try {
            const data = await fetchWorld(world);

            if (!isWorldLorebook(data)) {
                continue;
            }

            // A group recorded since the file was read means another SillyTavern
            // tab has just made this world's group: leave it to that one.
            const recorded = data.extensions[WORLD_KEY]?.group;

            if (String(recorded ?? '') !== (recordedGroups.get(world) ?? '')) {
                continue;
            }

            await createWorldGroup(world, data);
            made.push(world);
        } catch (error) {
            console.error('[SideStage] Could not create the world group', world, error);
            toastr.error(error?.message || t`Unknown error`, t`Could not create a group for "${world}"`);
        }
    }

    if (!made.length) {
        return;
    }

    // Reloads the groups too, which is how the new ones reach ST's group list.
    await getCharacters();
    toastr.info(made.length === 1
        ? t`Created a group for the world "${made[0]}".`
        : t`Created groups for the worlds ${made.join(', ')}.`);
}

/**
 * Takes lorebooks changed outside SillyTavern (in the Character Editor) since
 * it read them. SillyTavern keeps every lorebook it has read for the whole page
 * load: prompts use that copy, and its World Info editor saves the whole copy
 * back on the next edit, over whatever changed in the file. So each lorebook it
 * holds is compared with its file, and a changed one is replaced by the file's
 * version (and reopened in the World Info editor if it is showing there).
 * Does nothing on a SillyTavern that doesn't export worldInfoCache.
 */
async function refreshCachedLorebooks() {
    const cache = worldInfo.worldInfoCache;

    if (!cache || typeof cache.keys !== 'function') {
        return;
    }

    await Promise.all([...cache.keys()].map(async (name) => {
        const data = await fetchWorld(name).catch(() => null);

        if (!data || !cache.has(name) || JSON.stringify(data) === JSON.stringify(cache.get(name))) {
            return;
        }

        cache.set(name, data);

        if (typeof worldInfo.reloadEditor === 'function') {
            worldInfo.reloadEditor(name);
        }
    }));
}

/**
 * The character list as SillyTavern's server has it now (shallow: each card's
 * name and linked lorebook are there), to compare with the one in memory.
 * @returns {Promise<object[]>}
 */
async function fetchCharacterList() {
    const response = await fetch('/api/characters/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error(t`SillyTavern could not list the characters.`);
    }

    const list = await response.json();
    return Array.isArray(list) ? list : [];
}

/**
 * What the world groups follow in a character list: each card's file, name
 * and linked lorebook (its world).
 * @param {object[]} list
 * @returns {string}
 */
function castSignature(list) {
    return list
        .filter(x => x?.avatar)
        .map(x => [x.avatar, x.name ?? '', getCharacterWorld(x)].join('\u0000'))
        .sort()
        .join('\u0001');
}

/**
 * Takes what the Character Editor changed since SillyTavern last looked, with
 * two requests: the character list and the lorebooks' extensions. Cards that
 * joined, left or were renamed (or a world renamed, which relinks its cards)
 * reload the characters and sync the groups, as ⟳ does; a lorebook made a
 * world, or no longer one, re-reads the worlds; otherwise only the worlds whose
 * layouts were saved elsewhere are merged in.
 */
async function catchUpWithEditor() {
    const [listed, extensions] = await Promise.all([fetchCharacterList(), fetchLorebookExtensions()]);

    if (castSignature(listed) !== castSignature(characters)) {
        await refreshWorlds({ reload: true });
        return;
    }

    const linked = [...new Set(characters.map(getCharacterWorld).filter(Boolean))];
    const worlds = linked.filter(name => isWorldLorebook({ extensions: extensions.get(name) }));

    if (worlds.length !== worldLorebooks.size || worlds.some(name => !worldLorebooks.has(name))) {
        await refreshWorlds();
        return;
    }

    for (const [world, base] of worldBases) {
        const file = extensions.get(world)?.[WORLD_KEY];

        if (file && typeof file === 'object' && stageRev(file) !== stageRev(base)) {
            await pullWorldStage(world, file);
        }
    }
}

/** Shortest wait between two catch-ups, as coming back fires both focus and visibilitychange. */
const CATCH_UP_GAP = 2000;
let catchingUp = null;
let caughtUpAt = 0;

/**
 * Back in the SillyTavern tab or window, maybe from the Character Editor: takes
 * the lorebooks, cards, worlds and layouts changed there meanwhile, so the
 * world groups are in step without ⟳ (catchUpWithEditor()). A World Info edit
 * made just before leaving the tab has been saved by then (ST saves it within
 * a second), so its file already has it. Left for the next return while a
 * reply is being generated, as reloading the characters would wait for it.
 */
export function onBackToTab() {
    if (document.visibilityState !== 'visible' || !worldsResolved || catchingUp || refreshingWorlds
        || isGenerating() || Date.now() - caughtUpAt < CATCH_UP_GAP) {
        return;
    }

    catchingUp = (async () => {
        try {
            await refreshCachedLorebooks();
            await catchUpWithEditor();
        } catch (error) {
            console.error('[SideStage] Could not catch up with changes made outside SillyTavern', error);
        } finally {
            catchingUp = null;
            caughtUpAt = Date.now();
        }
    })();
}

/**
 * Follows a card renamed in ST (which renames its file) in every layout.
 * ST itself fixes the group member lists.
 * @param {string} oldAvatar
 * @param {string} newAvatar
 */
export function renameInStages(oldAvatar, newAvatar) {
    /** @param {Stage} stage */
    const rename = (stage) => {
        let changed = false;

        for (const layout of stage.layouts) {
            if (layout.cards[oldAvatar]) {
                layout.cards[newAvatar] = layout.cards[oldAvatar];
                delete layout.cards[oldAvatar];
                changed = true;
            }
            if (layout.order.includes(oldAvatar)) {
                layout.order = layout.order.map(x => x === oldAvatar ? newAvatar : x);
                changed = true;
            }
        }

        return changed;
    };

    for (const [world, stage] of worldStages) {
        if (rename(stage)) {
            saveWorldStageDebounced(world);
        }
    }
}
