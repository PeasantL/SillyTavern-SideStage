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
    unshallowCharacter,
    chat,
    chat_metadata,
    addOneMessage,
    updateMessageBlock,
    messageFormatting,
    scrollChatToBottom,
    substituteParams,
    generateRaw,
    name1,
    system_message_types,
    system_avatar,
    default_avatar,
    getCurrentChatId,
    getCharacters,
    getRequestHeaders,
    saveChatConditional,
    ensureSwipes,
    syncMesToSwipe,
    syncSwipeToMes,
    refreshSwipeButtons,
} from '../../../../script.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
import { hideChatMessageRange } from '../../../chats.js';
import { parseReasoningFromString } from '../../../reasoning.js';
import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import {
    groups,
    selected_group,
    openGroupId,
    editGroup,
    unshallowGroupMembers,
    select_group_chats,
    group_generation_mode,
    DEFAULT_AUTO_MODE_DELAY,
} from '../../../group-chats.js';
import { saveWorldInfo } from '../../../world-info.js';
import { waitUntilCondition, uuidv4, getSortableDelay } from '../../../utils.js';
import { t } from '../../../i18n.js';
import { Popup } from '../../../popup.js';

// ═══════════════════════ Group roster ═══════════════════════


const MODULE_NAME = 'groupRoster';
const PANEL_ID = 'groupRoster';
/** Chat-scoped display name for narrator messages, set by ST's /sysname. */
const NARRATOR_NAME_KEY = 'narrator_name';
/** Where the Author's Note extension keeps the chat's note (its metadata_keys.prompt). */
const NOTE_PROMPT_KEY = 'note_prompt';
/** Chat-scoped state of the footer's Author's Note toggle. */
const NOTE_APPLIED_KEY = 'sidestage_note_applied';
/**
 * Avatar the viewer is pinned to, or null to follow whoever spoke last.
 * Deliberately not persisted: it is a way to look at one character for a
 * moment, not a property of the roster, so it resets with the chat.
 * @type {string|null}
 */
let focusedAvatar = null;

/**
 * @typedef {object} LayoutEntry
 * @property {boolean} active Whether the card is in the scene (unmuted) while this layout is selected
 * @property {boolean} greets Whether the card posts an opening message
 * @property {number|null} greeting Index into the card's group greetings, or null for random
 * @property {string} [greetingKey] Fingerprint of the pinned greeting's text (see greetingKey()), so the pin
 *     follows its greeting when the card's group greetings are reordered
 */

/**
 * A way to open a scene with this group's cast. Card order is the group's, so
 * a layout only stores what varies: who is in it, who speaks, and with what.
 * @typedef {object} Layout
 * @property {string} id
 * @property {string} name
 * @property {string} note Author's Note for this scene; blank falls back to the group's
 * @property {string} narrator Scene-setting text posted before the greetings; blank for none
 * @property {string[]} order Avatar file names, in the order the scene opens
 * @property {Record<string, LayoutEntry>} cards Keyed by avatar file name; absent means muted
 */

/**
 * What SideStage keeps for one group. The cast is the group's own member list,
 * and who is in the scene is who is unmuted, so neither is stored here.
 *
 * A group tied to a world keeps its stage in the world's lorebook (see the
 * Worlds region), with `group` naming the group; any other group keeps it in
 * the extension settings.
 * @typedef {object} Stage
 * @property {string} note Author's Note the footer toggle fills the chat with
 * @property {Layout[]} layouts Scenes that can be opened with this cast
 * @property {string} activeLayoutId Id of the selected layout, or '' for none
 * @property {string} [group] Id of the group, for a stage kept in a world's lorebook
 * @property {number} [rev] For a stage kept in a world's lorebook: raised by every save, by SideStage or the
 *     Character Editor, so a save can tell the file changed since it was read (see mergeStage())
 */

const rosterDefaults = {
    /** @type {Record<string, Stage>} Stages by group id, for groups not tied to a world. Created on demand. */
    groups: {},
    /**
     * Whether an OOC / Morality / Scene exchange is ghosted once it lands —
     * ST's own "Exclude message from prompts" — so it stays on screen but
     * never reaches a later reply. Toggled from the button row.
     * @type {boolean}
     */
    oocGhost: true,
    /**
     * What the Morality and Scene buttons ask, inside the fixed
     * ((OOC: Pause the roleplay and respond out of character. ...)) wrapper.
     * Blank falls back to these defaults.
     * @type {string}
     */
    moralityRequest: 'Describe the evil of the current scene in detail.',
    sceneRequest: 'Describe the current scene in detail.',
};

/**
 * Group whose stage the settings drawer edits. Empty means "follow the open
 * group", which is the state it returns to whenever the chat changes.
 * @type {string}
 */
let settingsGroupId = '';

/**
 * Fills in whatever a stage is missing, in place.
 * @param {object} stage
 * @returns {Stage}
 */
function normalizeStage(stage) {
    if (typeof stage.note !== 'string') {
        stage.note = '';
    }
    if (!Array.isArray(stage.layouts)) {
        stage.layouts = [];
    }
    if (typeof stage.activeLayoutId !== 'string') {
        stage.activeLayoutId = '';
    }

    for (const layout of stage.layouts) {
        if (typeof layout.note !== 'string') {
            layout.note = '';
        }
        if (typeof layout.narrator !== 'string') {
            layout.narrator = '';
        }
        if (!Array.isArray(layout.order)) {
            layout.order = [];
        }
        if (!layout.cards || typeof layout.cards !== 'object') {
            layout.cards = {};
        }
    }

    // A layout deleted from another tab, or settings rolled back, must not
    // leave the stage pointing at nothing.
    if (!stage.layouts.some(x => x.id === stage.activeLayoutId)) {
        stage.activeLayoutId = '';
    }

    return stage;
}

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

    // Rosters are gone: a group's cast is its member list. Drop the card lists
    // every earlier version kept (the flat list, free-standing rosters, and the
    // per-group bench), keeping each group's note and layouts.
    delete settings.cards;
    delete settings.rosters;
    delete settings.activeRosterId;
    delete settings.legacyRosters;
    // The Chat Completion prompt picker is gone, and so are the profile and
    // history pickers (the rewrites follow the selected profile and always
    // send the whole chat); drop what they saved.
    delete settings.oocPrompts;
    delete settings.assistProfile;
    delete settings.oocHistory;

    for (const stage of Object.values(settings.groups)) {
        delete stage.cards;
        normalizeStage(stage);
    }

    return settings;
}

/**
 * The stage of one group: from its world's lorebook when it is tied to one,
 * otherwise from the settings (created on first use).
 * @param {string} [groupId]
 * @returns {Stage|null} Null for no group, or while it isn't known yet whether the group has a world.
 */
function getStage(groupId) {
    if (!groupId || !groups.some(x => x.id === groupId)) {
        return null;
    }

    const world = getGroupWorld(groupId);

    if (world === null) {
        return null;
    }

    if (world) {
        return worldStages.get(world) ?? null;
    }

    const settings = getSettings();

    if (!settings.groups[groupId]) {
        settings.groups[groupId] = normalizeStage({});
        saveSettingsDebounced();
    }

    return settings.groups[groupId];
}

/**
 * Saves a group's stage wherever it lives.
 * @param {string} groupId
 */
function saveStage(groupId) {
    const world = getGroupWorld(groupId);

    if (world) {
        saveWorldStageDebounced(world);
    } else {
        saveSettingsDebounced();
    }
}

/** @returns {Stage|null} The stage of the open group chat. */
function getActiveStage() {
    return getStage(getCurrentGroup()?.id);
}

/** @returns {string} Id of the group the settings drawer is editing. */
function getSettingsGroupId() {
    if (settingsGroupId && groups.some(x => x.id === settingsGroupId)) {
        return settingsGroupId;
    }

    return getCurrentGroup()?.id ?? groups[0]?.id ?? '';
}

/** @returns {object|null} The group the settings drawer edits. */
function getSettingsGroup() {
    return groups.find(x => x.id === getSettingsGroupId()) ?? null;
}

/** @returns {Stage|null} The stage the settings drawer edits. */
function getSettingsStage() {
    return getStage(getSettingsGroupId());
}

/**
 * @param {Stage|null} stage
 * @returns {Layout|null} The stage's selected layout, or null when none is.
 */
function getActiveLayout(stage) {
    return stage?.layouts.find(x => x.id === stage.activeLayoutId) ?? null;
}

/**
 * The group's members in the order this layout opens with.
 *
 * Stored as a plain list of avatars and reconciled against the members on
 * every read, so cards that left the group fall out and cards that joined it
 * appear at the end. That means an unsorted layout, or one whose group has
 * grown, still has a complete order without anything having to write one out.
 * @param {object|null} group
 * @param {Layout} layout
 * @returns {string[]}
 */
function getLayoutOrder(group, layout) {
    const members = Array.isArray(group?.members) ? group.members : [];
    const inGroup = new Set(members);
    const ordered = layout.order.filter(avatar => inGroup.has(avatar));
    const placed = new Set(ordered);

    return [...ordered, ...members.filter(avatar => !placed.has(avatar))];
}

/**
 * A card's settings within a layout. Cards that joined the group after the
 * layout was built are absent, and default to sitting the scene out, so a
 * growing cast never quietly rewrites an existing scene.
 * @param {Layout} layout
 * @param {string} avatar
 * @returns {LayoutEntry}
 */
function getLayoutEntry(layout, avatar) {
    return layout.cards[avatar] ?? { active: false, greets: false, greeting: null };
}

/**
 * Writes part of a card's layout entry back, creating it if needed.
 * @param {string} groupId Group whose stage holds the layout
 * @param {Layout} layout
 * @param {string} avatar
 * @param {Partial<LayoutEntry>} patch
 */
function setLayoutEntry(groupId, layout, avatar, patch) {
    const entry = Object.assign(getLayoutEntry(layout, avatar), patch);

    // Speaking, and which greeting to speak, only mean anything for a card that
    // is in the scene at all.
    if (!entry.active) {
        entry.greets = false;
        entry.greeting = null;
    }

    if (!Number.isInteger(entry.greeting)) {
        delete entry.greetingKey;
    }

    layout.cards[avatar] = entry;
    saveStage(groupId);
}

/**
 * A short fingerprint of a greeting: FNV-1a (32-bit, hex) over its code points,
 * with runs of whitespace collapsed to one space and the ends trimmed. Kept
 * beside a pin's index so the pin can find its greeting again after the card's
 * greetings are reordered; other tools that move greetings can compute the
 * same value to keep pins in step.
 * @param {string} text
 * @returns {string}
 */
function greetingKey(text) {
    let hash = 0x811c9dc5;

    for (const char of String(text ?? '').replace(/\s+/g, ' ').trim()) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, '0');
}

/**
 * Where a pinned greeting is in a card's pool now: found by its fingerprint,
 * else by its stored index (the text was edited), else nowhere.
 * @param {LayoutEntry} entry
 * @param {string[]} pool
 * @returns {number|null}
 */
function resolvePin(entry, pool) {
    if (!Number.isInteger(entry.greeting)) {
        return null;
    }

    if (entry.greetingKey) {
        const index = pool.findIndex(x => greetingKey(x) === entry.greetingKey);

        if (index !== -1) {
            return index;
        }
    }

    return entry.greeting < pool.length ? entry.greeting : null;
}

/**
 * The greetings a card can open a group scene with.
 *
 * Deliberately only the group-only pool, never first_mes or the ordinary
 * alternate greetings: pinning a scene's opening line is a promise about what
 * appears, and the ordinary greetings are written for a solo chat. A card with
 * no group greetings simply can't be pinned, and falls through to whatever ST
 * would have done.
 *
 * Precedence matches Extension-GroupGreetings' own reader so both agree on
 * which list is in play: Spec v3 group_only_greetings, with the legacy
 * extensions.group_greetings used only when v3 is present but empty.
 * @param {object} [character]
 * @returns {string[]}
 */
function getGroupGreetings(character) {
    const clean = (list) => list.filter(x => typeof x === 'string' && x.trim().length);
    const specV3 = character?.data?.group_only_greetings;
    const legacy = character?.data?.extensions?.group_greetings;

    if (Array.isArray(specV3) && Array.isArray(legacy) && legacy.length && !specV3.length) {
        return clean(legacy);
    }
    if (Array.isArray(specV3)) {
        return clean(specV3);
    }
    if (Array.isArray(legacy)) {
        return clean(legacy);
    }
    return [];
}

/**
 * Drops stages whose group is gone. There is no group-deleted event — only
 * GROUP_CHAT_DELETED — so this sweeps once the group list is known rather than
 * reacting to the deletion itself. Bails while the list is empty, since that is
 * indistinguishable from it not having loaded yet.
 */
function pruneOrphanStages() {
    if (!groups.length) {
        return;
    }

    const settings = getSettings();
    let dirty = false;

    for (const id of Object.keys(settings.groups)) {
        if (!groups.some(x => x.id === id)) {
            delete settings.groups[id];
            dirty = true;
        }
    }

    if (dirty) {
        saveSettingsDebounced();
    }
}

// #region Worlds

/**
 * Every world has its own group.
 *
 * A world is a lorebook the Character Editor has marked as one
 * (extensions.character_editor.world). Its cast is every card that links it
 * (data.extensions.world). SideStage creates a group for each world that has a
 * cast, named after it, and keeps it so: its members are exactly the world's
 * cards (they join and leave with the world), who is in the scene is who is
 * unmuted, and its name follows the world's. A world whose group is deleted
 * gets a new one; a group whose world is gone becomes an ordinary group, as
 * SideStage never deletes a group (that would delete its chats).
 *
 * Which group is the world's, and the group's stage, live in the lorebook under
 * extensions.sidestage ({group, note, activeLayoutId, layouts}), so they travel
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
const worldLorebooks = new Map();
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
function getGroupWorld(groupId) {
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

/** @returns {boolean} Whether a lorebook is marked as a world by the Character Editor. */
function isWorldLorebook(data) {
    return Boolean(data?.extensions?.character_editor?.world);
}

/**
 * Three-way merge of two objects keyed alike: every key changed here since
 * `base` takes this side's value (a removed key is removed), every other key
 * keeps the file's.
 * @param {object} local
 * @param {object} base
 * @param {object} file
 * @param {Record<string, function(any, any, any): any>} [nested] Keys merged by a function of their own
 * @returns {object}
 */
function mergeKeys(local, base, file, nested = {}) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const merged = structuredClone(file);

    for (const key of new Set([...Object.keys(local), ...Object.keys(base)])) {
        if (nested[key] && key in local && key in base && key in file) {
            merged[key] = nested[key](local[key], base[key], file[key]);
        } else if (!same(local[key], base[key])) {
            if (key in local) {
                merged[key] = structuredClone(local[key]);
            } else {
                delete merged[key];
            }
        }
    }

    return merged;
}

/**
 * Brings a world's stage up to the version in its file, keeping what changed
 * here since it was last read (`base`) and taking everything else from the
 * file, so layouts edited in the Character Editor (or another tab) meanwhile
 * are kept. Changes are kept per field: the group's note and selected layout,
 * a layout's name, note, narrator and order, and each card's entry in it.
 * Layouts added here are added; a layout deleted on either side stays deleted.
 * Done in place, as the drawer and panel hold on to the stage. The Character
 * Editor merges its saves the same way (worlds.merge_stage).
 * @param {Stage} local
 * @param {Stage} base
 * @param {object} file The stage in the file
 */
function mergeStage(local, base, file) {
    const merged = normalizeStage(structuredClone(file));
    const baseLayouts = new Map(base.layouts.map(x => [x.id, x]));
    const localLayouts = new Map(local.layouts.map(x => [x.id, x]));

    for (const key of ['note', 'activeLayoutId']) {
        if (local[key] !== base[key]) {
            merged[key] = local[key];
        }
    }

    merged.layouts = merged.layouts
        .filter(x => !baseLayouts.has(x.id) || localLayouts.has(x.id))
        .map(x => baseLayouts.has(x.id)
            ? mergeKeys(localLayouts.get(x.id), baseLayouts.get(x.id), x, { cards: mergeKeys })
            : x);

    for (const layout of local.layouts) {
        if (!baseLayouts.has(layout.id) && !merged.layouts.some(x => x.id === layout.id)) {
            merged.layouts.push(structuredClone(layout));
        }
    }

    merged.group = local.group;
    normalizeStage(merged);

    for (const key of Object.keys(local)) {
        delete local[key];
    }

    Object.assign(local, merged);
}

/** @returns {number} A stage's revision (0 for one saved before revisions). */
function stageRev(stage) {
    return Number.isInteger(stage?.rev) ? stage.rev : 0;
}

/**
 * Writes a world's stage into its lorebook, or removes it when the world no
 * longer has one. Re-reads the file first and replaces only extensions.sidestage,
 * so entries and anything else edited elsewhere in the meantime are kept; a
 * stage saved there since it was read (by the Character Editor) is merged with
 * this one rather than overwritten.
 * @param {string} world
 */
async function writeWorldStage(world) {
    const data = await fetchWorld(world);

    if (!data) {
        throw new Error(t`The lorebook "${world}" could not be read.`);
    }

    const extensions = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    const stage = worldStages.get(world);
    const file = extensions[WORLD_KEY] && typeof extensions[WORLD_KEY] === 'object' ? extensions[WORLD_KEY] : null;
    let written = null;

    if (stage) {
        const base = worldBases.get(world);
        const merge = Boolean(base && file && stageRev(file) !== stageRev(base));

        if (merge) {
            mergeStage(stage, base, file);
        }

        stage.rev = Math.max(stageRev(stage), stageRev(file)) + 1;
        written = structuredClone(stage);
        extensions[WORLD_KEY] = written;

        if (merge) {
            renderSettings();
            refreshPanel();
        }
    } else {
        delete extensions[WORLD_KEY];
    }

    if (Object.keys(extensions).length) {
        data.extensions = extensions;
    } else {
        delete data.extensions;
    }

    await saveWorldInfo(world, data, true);

    if (written) {
        worldBases.set(world, structuredClone(written));
    }
}

/**
 * Takes the world's stage from its file when it was saved elsewhere (layouts
 * edited in the Character Editor) since SideStage read it. A save waiting to
 * go is written first, which merges the two.
 * @param {string} world
 */
async function pullWorldStage(world) {
    if (pendingWorldSaves.has(world)) {
        await flushWorldSave(world);
        return;
    }

    const stage = worldStages.get(world);
    const base = worldBases.get(world);
    const data = stage && base ? await fetchWorld(world) : null;
    const file = data?.extensions?.[WORLD_KEY];

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
 * Works out which group each world is tied to, from the lorebooks the cards
 * link. Only those can be worlds with a cast; a world nobody links has no
 * cast and so no group to fill.
 */
async function resolveWorlds() {
    await flushWorldSaves();

    const names = [...new Set(characters.map(getCharacterWorld).filter(Boolean))];
    const stages = new Map();
    const lorebooks = new Map();
    const owners = new Map();
    const recorded = new Map();
    const bases = new Map();

    for (const name of names) {
        let data = null;

        try {
            data = await fetchWorld(name);
        } catch (error) {
            console.warn('[SideStage] Could not read the lorebook', name, error);
        }

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
 * Brings a world's group in step with its world: cards of the world that
 * aren't members join (muted, unless the selected layout puts them in the
 * scene), members that aren't in the world leave, and the name follows the
 * world's (renamed in the Character Editor).
 * @param {string} groupId
 * @returns {Promise<boolean>} Whether the group was changed
 */
async function syncWorldGroup(groupId) {
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

    const members = Array.isArray(group.members) ? group.members : [];
    const muted = Array.isArray(group.disabled_members) ? group.disabled_members : [];
    const kept = members.filter(avatar => cast.includes(avatar));
    const joined = cast.filter(avatar => !kept.includes(avatar));
    const nextMembers = [...kept, ...joined];
    const layout = getActiveLayout(getStage(groupId));
    const nextMuted = [
        ...muted.filter(avatar => kept.includes(avatar)),
        ...joined.filter(avatar => !(layout && getLayoutEntry(layout, avatar).active)),
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
function refreshWorlds({ reload = false } = {}) {
    if (refreshingWorlds) {
        return refreshingWorlds;
    }

    refreshingWorlds = (async () => {
        try {
            if (reload) {
                await waitUntilCondition(() => !isGenerating(), 30000, 200);
                await getCharacters();
            }

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
        }
    })();

    return refreshingWorlds;
}

/** Syncs the world groups shortly after a card changed in ST, once per burst of changes. */
const syncWorldGroupsSoon = debounce(() => {
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
    const response = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            name: world,
            members: getWorldCast(world),
            disabled_members: [],
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
 * Follows a card renamed in ST (which renames its file) in every layout.
 * ST itself fixes the group member lists.
 * @param {string} oldAvatar
 * @param {string} newAvatar
 */
function renameInStages(oldAvatar, newAvatar) {
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

    if (Object.values(getSettings().groups).map(rename).some(Boolean)) {
        saveSettingsDebounced();
    }

    for (const [world, stage] of worldStages) {
        if (rename(stage)) {
            saveWorldStageDebounced(world);
        }
    }
}

// #endregion

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
 * Mutes or unmutes a member of the open group chat. Muted members stay in the
 * group (and in its prompt as far as the group's settings say) but aren't
 * picked to reply; a forced turn still reaches them.
 * @param {string} avatar Avatar file name of the character
 * @param {boolean} shouldMute Target state: true = muted, false = in the scene
 * @returns {Promise<boolean>} Whether the group was actually changed
 */
async function setMuted(avatar, shouldMute) {
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
async function applyLayoutMutes() {
    const group = getCurrentGroup();
    const layout = getActiveLayout(getActiveStage());

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
 * Greeting text chosen during the current chat's creation, keyed by avatar.
 *
 * The greeting loop is the only place other extensions get to pick a greeting,
 * and it only runs for characters that were group members at the time. Their
 * choices are kept here so that rebuilding the scene afterwards reuses them
 * rather than asking again — which for Extension-GroupGreetings in pick mode
 * would mean a second dialog for the same character.
 *
 * Stamped with the chat it belongs to, so a scene can never be built out of
 * text left over from the previous one.
 * @type {{chatId: string, texts: Map<string, string>}}
 */
let capturedGreetings = { chatId: '', texts: new Map() };

/**
 * Captures and then suppresses one member's greeting while a group chat is
 * being created. Fires once per member, before its message is built.
 *
 * Every greeting is suppressed, not just the ones the layout leaves out: the
 * loop walks group.members, so it can never produce a greeting for a character
 * the layout wants but the group has lost, and a scene half-built by the loop
 * and half-repaired afterwards would come out in the wrong order. The loop is
 * left to run for the choices it collects, and openSceneFromLayout() builds the
 * whole opening from them.
 * @param {{input: string, output: string, character: object}} args
 */
function applyLayoutGreeting(args) {
    const group = getCurrentGroup();
    const layout = getActiveLayout(getActiveStage());
    const avatar = args?.character?.avatar;

    if (!avatar || !group) {
        return;
    }

    if (!isLayoutUsable(group, layout)) {
        // A world group's mutes are its scene, so with no layout the muted sit
        // the opening out too, where stock ST greets with every member.
        if (getGroupWorld(group.id) && group.disabled_members?.includes(avatar)) {
            args.output = ' ';
        }
        return;
    }

    const chatId = String(getCurrentChatId() ?? '');

    if (capturedGreetings.chatId !== chatId) {
        capturedGreetings = { chatId, texts: new Map() };
    }

    capturedGreetings.texts.set(avatar, String(args.output || args.input || ''));

    // Whitespace rather than '': group-chats.js only takes the override when it
    // is truthy, so an empty string would leave the random pick standing. A
    // space survives that check, is trimmed to nothing immediately after, and a
    // member whose first message is empty is dropped from the chat.
    args.output = ' ';
}

/**
 * The line a character opens the scene with.
 * @param {Layout} layout
 * @param {object} character
 * @param {Map<string, string>} captured
 * @returns {string}
 */
function getOpeningLine(layout, character, captured) {
    const entry = getLayoutEntry(layout, character.avatar);
    const pool = getGroupGreetings(character);

    const pinned = resolvePin(entry, pool);

    if (pinned !== null) {
        return pool[pinned];
    }

    if (captured.has(character.avatar)) {
        return captured.get(character.avatar);
    }

    // Never reached the greeting loop, so nothing chose for it (the character
    // joined after the chat was built). Mirror what ST and
    // Extension-GroupGreetings would have done.
    const options = pool.length
        ? pool
        : [character.first_mes, ...(character.data?.alternate_greetings ?? [])].filter(x => x);

    return options.length ? options[Math.floor(Math.random() * options.length)] : '';
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
 * what puts the greetings in the layout's order (the loop walks the member
 * list) and lets a card that joined since the chat was built greet too. The
 * mutes are applied first, so the scene and its greetings land together.
 * @returns {Promise<void>}
 */
async function openSceneFromLayout() {
    const group = getCurrentGroup();
    const layout = getActiveLayout(getActiveStage());

    const captured = capturedGreetings.chatId === String(getCurrentChatId() ?? '')
        ? capturedGreetings.texts
        : new Map();
    capturedGreetings = { chatId: '', texts: new Map() };

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

        if (!character || !entry.active || !entry.greets) {
            continue;
        }

        messages.push(buildGreetingMessage(character, getOpeningLine(layout, character, captured)));
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
function getEffectiveNote() {
    const stage = getActiveStage();
    return getActiveLayout(stage)?.note || stage?.note || '';
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
function isNoteApplied() {
    return Boolean(chat_metadata[NOTE_APPLIED_KEY]);
}

/**
 * Applies the active roster's Author's Note to the current chat, or clears the
 * chat's note when switched off.
 * @param {boolean} shouldApply
 */
function setNoteApplied(shouldApply) {
    const note = getEffectiveNote();

    if (shouldApply && !note) {
        toastr.info(t`This group has no Author's Note. Set one in Extensions → SideStage.`);
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
function syncNoteToChat() {
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
function watchManualNoteEdits() {
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
 * Pins the viewer to one character, or hands it back to the last speaker.
 * @param {string|null} avatar
 */
function setFocusedAvatar(avatar) {
    focusedAvatar = avatar;
    refreshPanel();
    refocusViewer();
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

// #region AI assist

/**
 * The footer's three rewrite actions.
 *
 * Each one is a stateless request of its own rather than a trip through
 * Generate(): the chat's own prompt is never rebuilt or re-sent, so a rewrite
 * costs one small call and leaves the ongoing conversation exactly as it was.
 */

/** Headroom over the source, so a rewrite is never clipped mid-sentence. */
function assistBudget(text) {
    return Math.min(4096, Math.max(512, Math.ceil(String(text ?? '').length / 2) + 256));
}

/**
 * A result far shorter than its source means the model summarized instead of
 * rewriting, or ran out of budget. Neither belongs in the chat. Directive is
 * exempt: "make this shorter" is a fair thing to ask for.
 */
const ASSIST_MIN_LENGTH_RATIO = 0.6;

const PERSPECTIVE_PROMPT = [
    'You are a text editor. You correct the narrative perspective of one passage',
    'of roleplay prose, and you change nothing else.',
    '',
    'The house perspective:',
    'Narrate {{char}} and all other characters in third person, by name or by the',
    'pronouns their card specifies. Never "I" for {{char}} outside quoted dialogue.',
    'Narrate {{user}} in second person: "you," "your."',
    '',
    'Never touch spoken dialogue. Anything inside double quotes is already',
    'correct: a character says "I" about themselves and "you" to {{user}}, and',
    'that stays exactly as it is.',
    '',
    'Choosing pronouns: match whatever the passage already uses for a character.',
    'Where it establishes none, use they/them. Never guess from a name.',
    '',
    'Rules you must follow exactly:',
    '- Change only what the perspective requires: pronouns, the verb agreement',
    '  that follows them, and the names used for {{user}}.',
    '- Do not reword, restructure, shorten, expand or improve anything else.',
    '- Do not change the tense, the meaning, or the order of events.',
    '- Preserve every line break, paragraph and formatting mark (asterisks,',
    '  quotes, brackets) exactly as it is.',
    '- Tokens of the form [[M0]], [[M1]] are placeholders. Copy them through',
    '  exactly as written.',
    '- If the passage is already in the house perspective, return it completely',
    '  unchanged.',
    '',
    'Output the rewritten passage and nothing else. No preamble, no explanation,',
    'no code fences, no commentary.',
].join('\n');

const DIRECTIVE_PROMPT = [
    'You are a text editor working inside a roleplay chat. You are shown the',
    'conversation so far and then a directive. Rewrite the final character reply',
    'so that it follows the directive, and change nothing the directive does not',
    'ask for.',
    '',
    'Rules you must follow exactly:',
    '- Rewrite only that final reply. Never continue the scene past it, and never',
    '  write anyone else\'s turn or the next thing that happens.',
    '- Keep the same speaker, and keep their voice, perspective and tense unless',
    '  the directive says to change them.',
    '- Match the formatting the rest of the chat uses: quotes for speech,',
    '  asterisks where it uses them, a comparable length and paragraph rhythm.',
    '- Do not open with a speaker name, a preamble, or a note on what you changed.',
    '',
    'Output the rewritten reply and nothing else. No code fences, no commentary.',
].join('\n');

const SPELLCHECK_PROMPT = [
    'You are a copy editor. You correct one passage of text and return it.',
    '',
    'Correct:',
    '- Misspelled words and typos.',
    '- Punctuation, spacing and capitalisation errors.',
    '- Clear grammar errors: subject-verb agreement, tense slips, wrong word',
    '  forms, missing or doubled words.',
    '',
    'Leave alone:',
    '- Word choice, tone, register and voice. Do not make the writing better.',
    '- Sentence order, paragraph breaks and line breaks.',
    '- Deliberate style: dialect, slang, sentence fragments, and roleplay',
    '  formatting marks such as *asterisks*, quotes and brackets.',
    '- Proper nouns and invented names, however unusual their spelling.',
    '- Tokens of the form [[M0]], [[M1]] — placeholders. Copy them through',
    '  exactly as written.',
    '',
    'If the text is already correct, return it completely unchanged.',
    '',
    'Output the corrected text and nothing else. No preamble, no explanation, no',
    'code fences, no commentary, and no list of what you changed.',
].join('\n');

/**
 * The connection profile selected in ST's Connection Manager, when there is
 * one that can serve a one-shot request; null means the plain active
 * connection (no profile, an unsupported one, or the Connection Manager off).
 * @returns {{id: string, name: string}|null}
 */
function getAssistProfile() {
    try {
        const context = SillyTavern.getContext();
        const selected = context.extensionSettings.connectionManager?.selectedProfile;
        return selected
            ? context.ConnectionManagerRequestService.getSupportedProfiles().find(x => x.id === selected) ?? null
            : null;
    } catch {
        return null;
    }
}

/**
 * Hides {{macros}} behind inert tokens.
 *
 * Every path to a model runs substituteParams over what it sends, so an
 * unmasked {{user}} would come back expanded — and be written into the message
 * or the message box as a literal name, losing the macro for good.
 * @param {string} text
 * @returns {{masked: string, extras: string[]}}
 */
function maskMacros(text) {
    const extras = [];
    const masked = String(text ?? '').replace(/\{\{[^{}]*\}\}/g, (match) => {
        extras.push(match);
        return `[[M${extras.length - 1}]]`;
    });

    return { masked, extras };
}

/**
 * @param {string} text
 * @param {string[]} extras
 * @returns {string}
 */
function unmaskMacros(text, extras) {
    return String(text ?? '').replace(/\[\[M(\d+)\]\]/g, (match, index) => extras[Number(index)] ?? match);
}

/** Reasoning models leak their thinking into the body, and most models fence prose. */
function cleanAssistOutput(raw) {
    let out = String(raw ?? '');

    try {
        const parsed = parseReasoningFromString(out, { strict: false });
        if (parsed && typeof parsed.content === 'string') {
            out = parsed.content;
        }
    } catch (error) {
        console.warn('[SideStage] Reasoning parse failed', error);
    }

    out = out.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
    const fence = out.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);

    return (fence ? fence[1] : out).trim();
}

/**
 * Mid-stream cleanup, deliberately lighter than the final pass: the closing tag
 * of a reasoning block may simply not have arrived yet, so an unterminated one
 * is dropped along with the closed ones rather than shown as markup.
 */
function previewAssistOutput(text) {
    return String(text ?? '')
        .replace(/<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi, '')
        .replace(/^\s*```[^\n]*\n?/, '')
        .trimStart();
}

/** Models echo the speaker label they were shown; the message already has one. */
function stripSpeakerPrefix(text, name) {
    const escaped = String(name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped
        ? String(text ?? '').replace(new RegExp(`^\\s*${escaped}\\s*:\\s*`), '')
        : String(text ?? '');
}

/**
 * Runs one chat-shaped request and returns the cleaned reply.
 *
 * Passing onProgress asks for a streamed response, and is only honoured on a
 * connection profile: generateRaw has no streaming path, so the fallback fills
 * its target in one go when the whole reply lands.
 * @param {{role: string, content: string}[]} messages
 * @param {number} maxTokens
 * @param {((text: string) => void)|null} [onProgress] Called with the reply so far
 * @returns {Promise<string>}
 */
async function runAssistRequest(messages, maxTokens, onProgress = null) {
    const profile = getAssistProfile();

    if (profile) {
        const service = SillyTavern.getContext().ConnectionManagerRequestService;
        // Text-completion profiles need the messages flattened through their
        // instruct template; chat-completion profiles get the array back as-is.
        const prompt = service.constructPrompt(messages, profile.id);
        const isTextCompletion = service.validateProfile(profile)?.selected === 'textgenerationwebui';
        // These are edits, not writing: reasoning would only be stripped off
        // again, and on OpenRouter it is this pair that actually stops it
        // rather than merely hiding it.
        const overrides = isTextCompletion
            ? { include_reasoning: false }
            : { include_reasoning: false, reasoning_effort: 'min' };
        const stream = Boolean(onProgress);
        const result = await service.sendRequest(profile.id, prompt, maxTokens, { stream }, overrides);

        if (!stream) {
            return cleanAssistOutput(result?.content ?? result);
        }

        // Streaming hands back a generator factory rather than the text, and
        // each chunk carries the whole reply so far rather than just the part
        // that is new.
        let text = '';

        for await (const chunk of result()) {
            text = chunk?.text ?? text;
            onProgress(previewAssistOutput(text));
        }

        return cleanAssistOutput(text);
    }

    // No profile: the connection that is already selected. createRawPrompt puts
    // a speaker name in front of every message unless the message carries one,
    // and these already name their speaker inline, so an empty name is what
    // keeps it from doubling them up.
    const systemPrompt = messages.filter(x => x.role === 'system').map(x => x.content).join('\n\n');
    const prompt = messages.filter(x => x.role !== 'system').map(x => ({ ...x, name: '' }));

    return cleanAssistOutput(await generateRaw({ prompt, systemPrompt, responseLength: maxTokens }));
}

/**
 * The last reply a character posted: what Perspective and Directive rewrite.
 *
 * Your own turns are skipped, so the button still lands on the reply once you
 * have typed the next thing, and so are narrator lines, which belong to the
 * scene rather than to anyone in it.
 * @returns {number} Index into chat, or -1 when there is nothing to rewrite
 */
function getLatestCharacterMessageId() {
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];

        if (!message || message.is_user || message.is_system) {
            continue;
        }

        if (message.extra?.type === system_message_types.NARRATOR) {
            continue;
        }

        if (String(message.mes ?? '').trim()) {
            return index;
        }
    }

    return -1;
}

/**
 * Replaces a message's text in place and persists it.
 *
 * The swipe it is currently sitting on is written too, or the rewrite is undone
 * the moment you swipe away and back.
 * @param {number} messageId
 * @param {string} text
 * @returns {Promise<void>}
 */
async function replaceMessageText(messageId, text) {
    const message = chat[messageId];
    message.mes = text;

    if (Array.isArray(message.swipes) && message.swipes[message.swipe_id] !== undefined) {
        message.swipes[message.swipe_id] = text;
    }

    updateMessageBlock(messageId, message);
    await saveChatConditional();
}

/**
 * Adds text to a message as a new swipe, moves to it, and persists it.
 *
 * Keeps what was there reachable instead of overwriting it: the left chevron
 * on the last message, and the swipe picker on an older one — ST opens that
 * for any AI message carrying more than one swipe, so the rewrite is never
 * somewhere you cannot get back to.
 * @param {number} messageId
 * @param {string} text
 * @returns {Promise<void>}
 */
async function appendMessageSwipe(messageId, text) {
    const message = chat[messageId];

    // Seeds swipes/swipe_id/swipe_info for a message that has never been
    // swiped, then flushes the live text and extras into the swipe it is
    // sitting on — an edit made in place is what the left chevron should come
    // back to, not whatever the swipe held before that edit.
    ensureSwipes(message);

    if (!Array.isArray(message.swipes) || !Array.isArray(message.swipe_info)) {
        // ensureSwipes() turns away messages that cannot carry swipes at all —
        // user turns and small system notices. There is nothing to append to,
        // so the rewrite goes in where it stands rather than failing.
        await replaceMessageText(messageId, text);
        return;
    }

    syncMesToSwipe(messageId);

    // Same fields ST drops when it pushes extra swipes onto a message: they
    // describe how the text that was already there came to be. display_text
    // goes too, since updateMessageBlock() renders it over message.mes and
    // would show the old reply in place of the rewrite.
    const extra = structuredClone(message.extra ?? {});
    delete extra.token_count;
    delete extra.reasoning;
    delete extra.reasoning_duration;
    delete extra.display_text;

    message.swipes.push(text);
    message.swipe_info.push({
        send_date: getMessageTimeStamp(),
        gen_started: message.gen_started,
        gen_finished: message.gen_finished,
        extra,
    });
    // syncSwipeToMes() is what copies the new swipe's text and extras onto the
    // message itself, so the two never drift apart here.
    syncSwipeToMes(messageId, message.swipes.length - 1);

    updateMessageBlock(messageId, message);
    // true: redraw the counter too, or it still reads the old "1/1".
    refreshSwipeButtons(true);
    await saveChatConditional();
}

/**
 * Paints a streaming rewrite into a message as it arrives, and can put the
 * message back the way it looked when the result turns out to be unusable —
 * by then a partial rewrite is already on screen over it.
 * @param {number} messageId
 * @returns {{onProgress: ((text: string) => void)|null, restore: () => void}}
 */
function streamIntoMessage(messageId) {
    const message = chat[messageId];
    const dom = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);

    if (!dom) {
        return { onProgress: null, restore: () => { } };
    }

    const original = dom.innerHTML;
    const chatDom = document.getElementById('chat');
    // Follow the text down only for someone already sitting at the bottom.
    // Yanking back a reader who had scrolled up costs more than a rewrite
    // growing off the end of the screen.
    const follow = chatDom
        ? chatDom.scrollHeight - chatDom.scrollTop - chatDom.clientHeight < 40
        : false;

    return {
        onProgress: (text) => {
            dom.innerHTML = messageFormatting(text, message.name, message.is_system, message.is_user, messageId);

            if (follow) {
                scrollChatToBottom();
            }
        },
        restore: () => {
            dom.innerHTML = original;
        },
    };
}

/**
 * Every message up to and including one index, as role-tagged turns. Speakers
 * are named inline so a group's voices stay apart; narrator lines go in
 * unattributed, as the scene text they are.
 * @param {number} lastId
 * @returns {{role: string, content: string}[]}
 */
function buildChatMessages(lastId) {
    const messages = [];

    for (let index = 0; index <= lastId; index++) {
        const message = chat[index];
        const text = String(message?.mes ?? '').trim();

        if (!message || message.is_system || !text) {
            continue;
        }

        const isNarrator = message.extra?.type === system_message_types.NARRATOR;
        messages.push({
            role: message.is_user ? 'user' : 'assistant',
            content: isNarrator ? text : `${message.name}: ${text}`,
        });
    }

    return messages;
}

/** One action at a time, and never on top of a reply that is still arriving. */
let assistRunning = false;

/**
 * Shared wrapper for the three footer actions: the generation guard, the
 * button's own spinner, and one place for a failure to surface.
 * @param {HTMLElement} button
 * @param {string} label Used as the toast title when the run fails
 * @param {() => Promise<void>} work
 * @returns {Promise<void>}
 */
async function runAssistAction(button, label, work) {
    if (assistRunning) {
        return;
    }

    // Claimed before the first await: two quick clicks would otherwise both be
    // past the guard while the generation check was still pending.
    assistRunning = true;

    const icon = button?.querySelector('i');
    const iconClass = icon?.className ?? '';

    button?.classList.add('gr-footer-action-busy');

    if (icon) {
        icon.className = 'fa-solid fa-spinner fa-spin fa-fw';
    }

    try {
        try {
            await waitUntilCondition(() => !isGenerating(), 10000, 100);
        } catch {
            toastr.warning(t`Cannot run while a reply is being generated.`);
            return;
        }

        await work();
    } catch (error) {
        console.error(`[SideStage] ${label} failed`, error);
        toastr.error(error?.message ?? String(error), label);
    } finally {
        assistRunning = false;
        button?.classList.remove('gr-footer-action-busy');

        if (icon) {
            icon.className = iconClass;
        }
    }
}

/**
 * Corrects the perspective of the latest character reply, and only that reply:
 * the passage goes up on its own, with no chat history behind it, because
 * whose pronouns are whose is answerable from the passage alone.
 * @returns {Promise<void>}
 */
async function runPerspective() {
    const messageId = getLatestCharacterMessageId();

    if (messageId === -1) {
        toastr.info(t`No character reply to work on yet.`);
        return;
    }

    const message = chat[messageId];
    const original = message.mes;
    const { masked, extras } = maskMacros(original);
    const systemPrompt = substituteParams(PERSPECTIVE_PROMPT, {
        name1Override: name1,
        name2Override: message.name,
    });

    const { onProgress, restore } = streamIntoMessage(messageId);
    let restoreNeeded = true;

    try {
        const result = await runAssistRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Rewrite this passage.\n\n${masked}` },
        ], assistBudget(masked), onProgress);

        const rewritten = stripSpeakerPrefix(unmaskMacros(result, extras), message.name);

        if (!rewritten) {
            throw new Error(t`The model returned nothing.`);
        }

        if (rewritten.length < original.length * ASSIST_MIN_LENGTH_RATIO) {
            const percent = Math.round((rewritten.length / original.length) * 100);
            throw new Error(t`Result is only ${percent}% of the original length — likely truncated. Discarded.`);
        }

        if (rewritten === original) {
            toastr.info(t`Already in the right perspective.`);
            return;
        }

        await replaceMessageText(messageId, rewritten);
        restoreNeeded = false;
    } finally {
        // Anything short of a saved rewrite puts the message back: the stream
        // has already painted a partial one over the top of it.
        if (restoreNeeded) {
            restore();
        }
    }
}

/**
 * Rewrites the latest character reply to follow whatever is typed in the
 * message box. The whole chat goes up with it, so the rewrite can honour an
 * instruction that only makes sense in light of the scene so far.
 * @returns {Promise<void>}
 */
async function runDirective() {
    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    const typed = String(textarea?.value ?? '');
    const directive = typed.trim();

    if (!directive) {
        toastr.info(t`Type the directive in the message box first.`);
        return;
    }

    const messageId = getLatestCharacterMessageId();

    if (messageId === -1) {
        toastr.info(t`No character reply to work on yet.`);
        return;
    }

    const message = chat[messageId];
    // The target is the last turn of the history rather than a block quoted
    // again underneath it: the model rewrites the reply where it stands, with
    // everything that led to it already in front of it.
    //
    // The stream paints over the reply as it arrives; what lands is committed
    // as a new swipe, so the original is still a chevron away.
    const { onProgress, restore } = streamIntoMessage(messageId);
    let restoreNeeded = true;

    try {
        const result = await runAssistRequest([
            { role: 'system', content: DIRECTIVE_PROMPT },
            ...buildChatMessages(messageId),
            {
                role: 'user',
                content: `${directive}\n\nRewrite ${message.name}'s reply — the last one above — to follow that. Output only the rewritten reply.`,
            },
        ], assistBudget(message.mes), onProgress);

        const rewritten = stripSpeakerPrefix(result, message.name);

        if (!rewritten) {
            throw new Error(t`The model returned nothing.`);
        }

        await appendMessageSwipe(messageId, rewritten);
        restoreNeeded = false;

        // Only the directive that was actually used is cleared; anything typed
        // while the request was in flight is somebody's next message, not spent.
        if (textarea.value === typed) {
            textarea.value = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } finally {
        if (restoreNeeded) {
            restore();
        }
    }
}

/**
 * Copy-edits what is in the message box, in place. Nothing is sent to the chat
 * and no history goes up with it — it is the text on its own.
 * @returns {Promise<void>}
 */
async function runSpellCheck() {
    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    const original = String(textarea?.value ?? '');

    if (!original.trim()) {
        toastr.info(t`Type something in the message box first.`);
        return;
    }

    const { masked, extras } = maskMacros(original);

    const write = (text) => {
        textarea.value = text;
        // The input event is what keeps ST's autosize and its draft in step.
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // A streamed check writes over the box as it goes; a run with no profile
    // behind it leaves the box alone until the whole reply lands, which is the
    // only case where the user can still be typing into it.
    let streamed = false;
    const onProgress = (text) => {
        streamed = true;
        write(text);
    };

    let restoreNeeded = true;

    try {
        const result = await runAssistRequest([
            { role: 'system', content: SPELLCHECK_PROMPT },
            { role: 'user', content: masked },
        ], assistBudget(masked), onProgress);

        const corrected = unmaskMacros(result, extras);

        if (!corrected) {
            throw new Error(t`The model returned nothing.`);
        }

        if (corrected.length < original.trim().length * ASSIST_MIN_LENGTH_RATIO) {
            throw new Error(t`Result is much shorter than what you typed — likely truncated. Discarded.`);
        }

        if (!streamed && textarea.value !== original) {
            // Overwriting a message the user has moved on to writing would cost
            // more than the correction is worth, and so would restoring it.
            restoreNeeded = false;
            toastr.warning(t`The message box changed while the check was running, so it was left alone.`);
            return;
        }

        if (corrected === original.trim()) {
            toastr.info(t`Nothing to correct.`);
            return;
        }

        write(corrected);
        restoreNeeded = false;
    } finally {
        if (restoreNeeded) {
            write(original);
        }
    }
}

/**
 * The OOC / Morality / Scene buttons: a real turn, not a rewrite. An
 * ((OOC: ...)) line goes into the chat as a user message the normal way, and
 * whoever is currently speaking answers it out of character — but the answer
 * is still a one-shot request like the rewrite actions, not a Generate() call,
 * so it never touches World Info, Author's Note, persona or the jailbreak: the
 * only context it gets is the chat itself.
 */

const OOC_REPLY_PROMPT = [
    'You are {{char}}, in an ongoing roleplay chat with {{user}}. You have just',
    'been asked an out-of-character (OOC) question, and you are answering as',
    'yourself — the person behind the character — not staying in character for',
    'the roleplay.',
    '',
    'Rules you must follow exactly:',
    '- Answer only the OOC request, plainly and directly.',
    '- Do not continue the roleplay scene, write the next in-character turn, or',
    '  speak for {{user}} or anyone else.',
    '- Wrap your whole reply in ((OOC: ...)), the same way the request was.',
    '- No preamble, and no roleplay formatting like *asterisks* in the OOC reply.',
].join('\n');

const OOC_MAX_TOKENS = 1024;

/**
 * Posts an OOC line as a real user turn, then asks whoever last spoke to
 * answer it out of character. Both land in the chat log the normal way.
 * @param {string} oocLine
 * @returns {Promise<void>}
 */
async function runOocTurn(oocLine) {
    const speakerMessageId = getLatestCharacterMessageId();

    if (speakerMessageId === -1) {
        toastr.info(t`No character to answer yet.`);
        return;
    }

    const speaker = chat[speakerMessageId];

    await sendMessageAsUser(oocLine, extractMessageBias(oocLine));
    const askMessageId = chat.length - 1;

    const systemPrompt = substituteParams(OOC_REPLY_PROMPT, {
        name1Override: name1,
        name2Override: speaker.name,
    });

    // The reply's bubble goes up empty and streams in, the same as a real
    // character turn — so it needs to exist in `chat` before the request even
    // starts, and comes back out again if the request fails or returns
    // nothing, since nothing has been announced to other extensions yet.
    const reply = {
        is_user: false,
        is_system: false,
        name: speaker.name,
        send_date: getMessageTimeStamp(),
        original_avatar: speaker.original_avatar,
        force_avatar: speaker.force_avatar,
        extra: { gen_id: Date.now() * Math.random() * 1000000 },
        mes: '',
    };

    chat.push(reply);
    const replyMessageId = chat.length - 1;
    addOneMessage(reply);

    const { onProgress } = streamIntoMessage(replyMessageId);

    try {
        const result = await runAssistRequest([
            { role: 'system', content: systemPrompt },
            ...buildChatMessages(askMessageId),
        ], OOC_MAX_TOKENS, onProgress);

        if (!result?.trim()) {
            throw new Error(t`The model returned nothing.`);
        }

        await replaceMessageText(replyMessageId, result);
        await eventSource.emit(event_types.MESSAGE_RECEIVED, replyMessageId, 'normal');
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, replyMessageId, 'normal');

        // With the Ghost toggle on, both halves of the aside are ghosted — the
        // same "Exclude message from prompts" state the mes_hide button sets —
        // so the exchange stays visible but never bleeds into a later
        // Generate() or the next OOC request's own history.
        if (getSettings().oocGhost) {
            await hideChatMessageRange(askMessageId, replyMessageId, false);
        }
    } catch (error) {
        chat.splice(replyMessageId, 1);
        $(`#chat .mes[mesid="${replyMessageId}"]`).remove();
        // The ask still happened and still gets ghosted on its own; only the
        // reply that never arrived is rolled back.
        if (getSettings().oocGhost) {
            await hideChatMessageRange(askMessageId, askMessageId, false);
        }
        throw error;
    }
}

/**
 * Wraps whatever is typed in the message box as an OOC question and sends it.
 * @returns {Promise<void>}
 */
async function runOOC() {
    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    const input = String(textarea?.value ?? '').trim();

    if (!input) {
        toastr.info(t`Type your out-of-character question in the message box first.`);
        return;
    }

    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    await runOocTurn(`((OOC: Pause the roleplay and respond out of character: ${input}))`);
}

/**
 * Wraps one of the editable asides in the same OOC framing runOOC() uses. A
 * request cleared in the drawer falls back to the shipped wording rather than
 * posting an empty aside.
 * @param {'moralityRequest'|'sceneRequest'} key
 * @returns {string}
 */
function buildFixedOocLine(key) {
    const request = String(getSettings()[key] ?? '').trim() || rosterDefaults[key];
    return `((OOC: Pause the roleplay and respond out of character. ${request}))`;
}

/** Asks about the evil of the current scene, out of character. */
async function runMorality() {
    await runOocTurn(buildFixedOocLine('moralityRequest'));
}

/** Asks for a description of the current scene, out of character. */
async function runScene() {
    await runOocTurn(buildFixedOocLine('sceneRequest'));
}

const ASSIST_BAR_ID = 'sidestageAssistBar';

/**
 * Docks the rewrite and OOC-turn actions above the message box, in the same
 * #send_form slot the (optional) Quick Reply bar occupies — so they stay
 * reachable without opening the SideStage panel, whether or not Quick Reply
 * is enabled.
 */
function mountAssistBar() {
    const sendForm = document.getElementById('send_form');
    if (!sendForm || document.getElementById(ASSIST_BAR_ID)) {
        return;
    }

    const bar = document.createElement('div');
    bar.id = ASSIST_BAR_ID;
    bar.classList.add('gr-footer-actions');

    // The buttons sit in their own centred group so the Ghost toggle can be
    // pinned to the right edge without pulling them off centre.
    const actions = document.createElement('div');
    actions.classList.add('gr-assist-actions');
    bar.append(actions);

    // Two groups of three, split by a rule: the rewrites edit text that is
    // already there, the asides post a new exchange. `null` is the divider.
    for (const entry of [
        ['fa-user-pen', t`Perspective`, t`Correct the perspective of the latest character reply`, runPerspective],
        ['fa-wand-magic-sparkles', t`Directive`, t`Rewrite the latest character reply, following what you have typed in the message box`, runDirective],
        ['fa-spell-check', t`Spell check`, t`Copy-edit what you have typed in the message box`, runSpellCheck],
        null,
        ['fa-comment-dots', t`OOC`, t`Send what you have typed in the message box as an out-of-character question`, runOOC],
        ['fa-skull', t`Morality`, t`Ask, out of character, about the evil of the current scene`, runMorality],
        ['fa-image', t`Scene`, t`Ask, out of character, for a description of the current scene`, runScene],
    ]) {
        if (!entry) {
            const divider = document.createElement('div');
            divider.classList.add('gr-footer-divider');
            actions.append(divider);
            continue;
        }

        const [icon, label, title, action] = entry;
        const button = document.createElement('div');
        button.classList.add('gr-footer-btn', 'gr-footer-action');
        button.title = title;

        const iconEl = document.createElement('i');
        iconEl.classList.add('fa-solid', icon, 'fa-fw');

        const span = document.createElement('span');
        span.textContent = label;

        button.append(iconEl, span);
        button.addEventListener('click', () => runAssistAction(button, label, action));
        actions.append(button);
    }

    // Whether the OOC / Morality / Scene exchanges are ghosted once they land.
    // Same markup as the panel's Author's Note toggle, so it lights the same way.
    const ghost = document.createElement('label');
    ghost.id = 'sidestageGhostToggle';
    ghost.classList.add('gr-footer-btn', 'gr-footer-toggle', 'gr-footer-action');
    ghost.title = t`Exclude the OOC, Morality and Scene exchanges from prompts once they land, so they stay on screen but never reach a later reply`;

    const ghostInput = document.createElement('input');
    ghostInput.type = 'checkbox';
    ghostInput.checked = Boolean(getSettings().oocGhost);
    ghostInput.addEventListener('change', () => {
        getSettings().oocGhost = ghostInput.checked;
        saveSettingsDebounced();
    });

    const ghostIcon = document.createElement('i');
    ghostIcon.classList.add('fa-solid', 'fa-ghost', 'fa-fw');

    const ghostLabel = document.createElement('span');
    ghostLabel.textContent = t`Ghost`;

    ghost.append(ghostInput, ghostIcon, ghostLabel);
    bar.append(ghost);

    if (sendForm.children.length > 0) {
        sendForm.children[0].insertAdjacentElement('beforebegin', bar);
    } else {
        sendForm.append(bar);
    }
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

    // Toggle 2: force a turn (self-resets once generation finishes). Works for
    // muted members too: a muted character can still be given one line.
    const turn = makeIconToggle('gr-turn', 'fa-comment-dots', t`Make this character speak next`);
    turn.input.disabled = !group || !character;
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
 * Shared by the panel footer's picker and the settings drawer's.
 * @param {string} id
 */
async function setActiveLayout(id) {
    const stage = getActiveStage();

    if (!stage) {
        return;
    }

    stage.activeLayoutId = String(id);
    saveStage(getCurrentGroup().id);
    // The new layout may override the group's note, or stop overriding it.
    syncNoteToChat();

    try {
        await applyLayoutMutes();
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

    picker.value = stage?.activeLayoutId ?? '';
    picker.disabled = !stage;
}

/** Re-renders the card list inside an already open panel. */
function refreshPanel() {
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
            </div>
        </div>`;

    $('body').append(html);
    const $win = $(`#${PANEL_ID}`);

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

    $win.find('#groupRosterLayoutPicker').on('change', function () {
        const picker = this;
        picker.disabled = true;
        setActiveLayout(String($(picker).val())).finally(() => {
            picker.disabled = false;
        });
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
                <div class="ss-settings-heading">Group</div>
                <label for="gr_group_select">Group</label>
                <select id="gr_group_select" class="text_pole"></select>
                <div class="flex-container alignItemsCenter">
                    <small id="gr_world_status" class="ss-settings-hint flex1"></small>
                    <div id="gr_world_sync" class="menu_button menu_button_icon interactable" title="Reload the characters, create the groups worlds are missing, and bring every world's group in step with its cards">
                        <i class="fa-solid fa-rotate fa-fw"></i>
                    </div>
                </div>
                <label for="gr_roster_note">Author's Note for this group</label>
                <textarea id="gr_roster_note" class="text_pole textarea_compact" rows="3"
                          placeholder="Filled into this chat's Author's Note when the panel toggle is on"></textarea>
            </div>

            <div class="ss-settings-divider"></div>

            <div class="ss-settings-section">
                <div class="ss-settings-heading">Greeting layouts</div>
                <label for="gr_layout_select">Layout for this group</label>
                <div class="flex-container alignItemsCenter">
                    <select id="gr_layout_select" class="text_pole flex1"></select>
                    <div id="gr_layout_new" class="menu_button menu_button_icon interactable" title="New layout">
                        <i class="fa-solid fa-plus fa-fw"></i>
                    </div>
                    <div id="gr_layout_rename" class="menu_button menu_button_icon interactable" title="Rename layout">
                        <i class="fa-solid fa-pen fa-fw"></i>
                    </div>
                    <div id="gr_layout_delete" class="menu_button menu_button_icon interactable" title="Delete layout">
                        <i class="fa-solid fa-trash fa-fw"></i>
                    </div>
                </div>
                <div id="gr_layout_body">
                    <label for="gr_layout_narrator">Narrator opening</label>
                    <textarea id="gr_layout_narrator" class="text_pole textarea_compact" rows="3"
                              placeholder="Posted before the greetings to set the scene. Leave blank for none."></textarea>
                    <label for="gr_layout_note">Author's Note for this layout</label>
                    <textarea id="gr_layout_note" class="text_pole textarea_compact" rows="3"
                              placeholder="Overrides the group's note while this layout is selected"></textarea>
                    <div id="gr_layout_cards" class="gr-layout-grid"></div>
                </div>
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
                <small class="ss-settings-hint">Each is posted as <code>((OOC: Pause the roleplay and respond out of character. …))</code> and answered by whoever spoke last. Blank restores the default.</small>
            </div>

            <div class="ss-settings-divider"></div>

            <div class="ss-settings-section">
                <div class="ss-settings-heading">Images</div>
                <div class="ss-settings-toggles">
                    <label class="checkbox_label" for="civ-auto-open" title="Opens the floating viewer whenever a character or group with images is selected. With this off there is no way to open the viewer, since the gallery is reached from it.">
                        <input id="civ-auto-open" type="checkbox">
                        <span>Open automatically</span>
                    </label>
                    <label class="checkbox_label" for="civ-change-with-greeting" title="Opens on the image referenced by the greeting on screen, and switches when you swipe to an alternate greeting. With this off the viewer opens on the first image found and stays put until you navigate it yourself.">
                        <input id="civ-change-with-greeting" type="checkbox">
                        <span>Change with greeting</span>
                    </label>
                </div>
            </div>
        </div>
    </div>
</div>`;

/** Fills the group dropdown, which is what picks the stage being edited. */
function renderGroupSelect() {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('gr_group_select'));

    if (!select) {
        return;
    }

    select.innerHTML = '';
    select.disabled = !groups.length;

    if (!groups.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = t`No group chats yet`;
        select.appendChild(option);
        return;
    }

    for (const group of groups) {
        const option = document.createElement('option');
        option.value = group.id;
        // A world's group is named after its world, so the name says both.
        option.textContent = `${group.name} (${group.members?.length ?? 0})`;
        select.appendChild(option);
    }

    select.value = getSettingsGroupId();
}

/** Says whether the group being edited is a world's group. */
function renderWorldRow() {
    const status = document.getElementById('gr_world_status');

    if (!status) {
        return;
    }

    const group = getSettingsGroup();
    const world = group ? getGroupWorld(group.id) : '';

    status.textContent = !group ? t`No group chats yet. Every world (a lorebook marked by the Character Editor) gets its own group.`
        : world ? t`A world's group: its members are the world's cards, and they join and leave with the world. Mute and unmute them from the panel.`
            : t`An ordinary group: its members are managed in SillyTavern's group settings. Every world gets its own group.`;
}

/** @returns {Layout|null} The layout the settings drawer edits. */
function getSettingsLayout() {
    return getActiveLayout(getSettingsStage());
}

/** True while member cards are being loaded, so the repaint can't loop. */
let loadingCardData = false;

/**
 * Members of a group that isn't open are shallow, and a shallow card has no
 * data.group_only_greetings to list — the greeting column would read as "no
 * group greetings" for every card. Loads them once and repaints.
 * @param {object|null} group
 */
function ensureGreetingsLoaded(group) {
    if (loadingCardData || !group) {
        return;
    }

    const pending = (group.members ?? [])
        .map(avatar => characters.findIndex(x => x.avatar === avatar))
        .filter(chid => chid !== -1 && characters[chid]?.shallow);

    if (!pending.length) {
        return;
    }

    loadingCardData = true;

    (async () => {
        try {
            for (const chid of pending) {
                await unshallowCharacter(chid);
            }
        } catch (error) {
            console.error('[SideStage] Could not load card data for the layout editor', error);
        } finally {
            loadingCardData = false;
            renderLayoutCards();
        }
    })();
}

/** Fills the layout dropdown for whichever group the drawer is showing. */
function renderLayoutSelect() {
    const stage = getSettingsStage();
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('gr_layout_select'));

    if (!select) {
        return;
    }

    select.innerHTML = '';
    select.disabled = !stage;

    // Always offered: a group with no layout selected is left entirely alone,
    // which is the only way back to stock behaviour once layouts exist.
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t`No layout`;
    select.appendChild(none);

    for (const layout of stage?.layouts ?? []) {
        const option = document.createElement('option');
        option.value = layout.id;
        option.textContent = layout.name;
        select.appendChild(option);
    }

    select.value = stage?.activeLayoutId ?? '';
    $('#gr_layout_new').toggleClass('disabled', !stage);
    $('#gr_layout_rename').toggleClass('disabled', !getSettingsLayout());
    $('#gr_layout_delete').toggleClass('disabled', !getSettingsLayout());
}

/**
 * Builds one checkbox cell of the layout matrix.
 * @param {{checked: boolean, disabled: boolean, title: string, onChange: function(boolean): void}} options
 * @returns {HTMLLabelElement}
 */
function makeLayoutCheckbox({ checked, disabled, title, onChange }) {
    const cell = document.createElement('label');
    cell.classList.add('gr-layout-check');
    cell.title = title;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', () => onChange(input.checked));

    cell.appendChild(input);
    return cell;
}

/**
 * Builds the greeting picker for one card. Only group greetings are offered;
 * a card without any can still greet, just not from a pinned line.
 *
 * Returned wrapped in a cell, because the cell is what shrinks: Safari sizes a
 * <select> to its widest option and will not go below that however min-width is
 * set, so on iOS the select is told to fill a cell that can shrink instead of
 * being the flex item itself.
 * @param {Layout} layout
 * @param {string} avatar
 * @param {object} [character]
 * @param {LayoutEntry} entry
 * @returns {HTMLElement}
 */
function makeGreetingSelect(layout, avatar, character, entry) {
    const cell = document.createElement('div');
    cell.classList.add('gr-layout-greeting');

    const select = document.createElement('select');
    select.classList.add('text_pole', 'gr-layout-greeting-select');
    cell.appendChild(select);

    const greetings = getGroupGreetings(character);

    if (!greetings.length) {
        const option = document.createElement('option');
        option.textContent = t`No group greetings`;
        select.appendChild(option);
        select.disabled = true;
        select.title = t`Only group greetings can be pinned. Add some from the button beside Alt. Greetings on the card.`;
        return cell;
    }

    const random = document.createElement('option');
    random.value = '';
    random.textContent = t`Random`;
    select.appendChild(random);

    greetings.forEach((text, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        // Long enough to fill the column on a wide drawer; a narrower one clips
        // it with an ellipsis, and the full text is on the title either way.
        // Safe to be this long now the cell shrinks rather than the select:
        // the option text no longer has any say in how wide the row is.
        const summary = text.replace(/\s+/g, ' ').trim();
        option.textContent = `${index + 1}. ${summary.length > 100 ? `${summary.slice(0, 100)}…` : summary}`;
        option.title = text;
        select.appendChild(option);
    });

    // Found by its text first, so a pin follows its greeting when the card's
    // greetings are reordered; one past the end of the list reads as random.
    const pinned = resolvePin(entry, greetings);
    select.value = pinned === null ? '' : String(pinned);
    select.disabled = !entry.greets;
    select.title = t`Which group greeting this card opens with`;

    select.addEventListener('change', () => {
        const index = select.value === '' ? null : Number(select.value);
        setLayoutEntry(getSettingsGroupId(), layout, avatar,
            { greeting: index, greetingKey: index === null ? undefined : greetingKey(greetings[index]) });
    });

    return cell;
}

/**
 * Builds one card's row. Rows are real elements rather than cells appended flat
 * into one grid, because a row has to be draggable as a unit; the columns are
 * held in line by fixed widths shared with the header instead.
 * @param {Layout} layout
 * @param {string} avatar
 * @returns {HTMLElement}
 */
function makeLayoutRow(layout, avatar) {
    const character = getCharacterByAvatar(avatar);
    const entry = getLayoutEntry(layout, avatar);

    const row = document.createElement('div');
    row.classList.add('gr-layout-row');
    row.dataset.avatar = avatar;

    const grip = document.createElement('i');
    grip.classList.add('fa-solid', 'fa-grip-vertical', 'gr-layout-grip');
    grip.title = t`Drag to change the order the scene opens in`;

    const card = document.createElement('div');
    card.classList.add('gr-layout-card');

    const thumb = document.createElement('img');
    thumb.classList.add('gr-settings-avatar');
    thumb.src = getThumbnailUrl('avatar', avatar);
    thumb.alt = character?.name ?? avatar;

    const name = document.createElement('span');
    name.classList.add('gr-settings-name');
    name.textContent = character?.name ?? avatar;

    if (!character) {
        name.classList.add('gr-card-missing');
        name.title = t`Character file not found`;
    }

    card.append(thumb, name);

    const active = makeLayoutCheckbox({
        checked: entry.active,
        disabled: !character,
        title: t`In the scene (unmuted) while this layout is selected`,
        onChange: (checked) => {
            // Being in the scene implies opening it; uncheck Greets to have a
            // card present from the start without a line of its own.
            setLayoutEntry(getSettingsGroupId(), layout, avatar, { active: checked, greets: checked });
            renderLayoutCards();
        },
    });

    const greets = makeLayoutCheckbox({
        checked: entry.greets,
        disabled: !character || !entry.active,
        title: t`Posts an opening message when a new chat starts`,
        onChange: (checked) => {
            setLayoutEntry(getSettingsGroupId(), layout, avatar, { greets: checked });
            renderLayoutCards();
        },
    });

    row.append(grip, card, active, greets, makeGreetingSelect(layout, avatar, character, entry));
    return row;
}

/** Paints the matrix: who is in the scene, who opens it, and with what. */
function renderLayoutCards() {
    const body = document.getElementById('gr_layout_body');
    const container = document.getElementById('gr_layout_cards');

    if (!body || !container) {
        return;
    }

    const group = getSettingsGroup();
    const layout = getSettingsLayout();

    body.style.display = layout ? '' : 'none';

    if (!layout) {
        return;
    }

    ensureGreetingsLoaded(group);
    container.innerHTML = '';

    if (!group?.members?.length) {
        const empty = document.createElement('div');
        empty.classList.add('gr-empty');
        empty.textContent = t`This group has no members.`;
        container.appendChild(empty);
        return;
    }

    const head = document.createElement('div');
    head.classList.add('gr-layout-head');

    for (const [label, className] of [['', 'gr-layout-grip'], [t`Card`, 'gr-layout-card'],
        [t`In scene`, 'gr-layout-check'], [t`Greets`, 'gr-layout-check'], [t`Greeting`, 'gr-layout-greeting']]) {
        const cell = document.createElement('span');
        cell.classList.add(className);
        cell.textContent = label;
        head.appendChild(cell);
    }

    container.appendChild(head);

    for (const avatar of getLayoutOrder(group, layout)) {
        container.appendChild(makeLayoutRow(layout, avatar));
    }
}

/**
 * Records the order the matrix was dragged into.
 *
 * Reads the order back out of the DOM rather than tracking the move, so it
 * stays right however jQuery UI got there. Nothing is re-rendered: the rows
 * are already where they belong, and rebuilding them under the widget that
 * just finished a drag is asking for trouble.
 */
function saveLayoutOrder() {
    const layout = getSettingsLayout();

    if (!layout) {
        return;
    }

    layout.order = $('#gr_layout_cards > .gr-layout-row').map((_, row) => row.dataset.avatar).get();
    saveStage(getSettingsGroupId());
}

function renderSettings() {
    if (!document.getElementById('gr_group_select')) {
        return;
    }

    renderGroupSelect();
    renderWorldRow();
    renderLayoutSelect();
    renderLayoutCards();
    $('#gr_roster_note').val(getSettingsStage()?.note ?? '').prop('disabled', !getSettingsStage());
    $('#gr_layout_note').val(getSettingsLayout()?.note ?? '');
    $('#gr_layout_narrator').val(getSettingsLayout()?.narrator ?? '');
    $('#ss_morality_request').val(getSettings().moralityRequest ?? '');
    $('#ss_scene_request').val(getSettings().sceneRequest ?? '');
}

function addSettings() {
    $('#extensions_settings2').append(settingsHtml);

    $('#ss_morality_request').on('input', function () {
        getSettings().moralityRequest = String($(this).val());
        saveSettingsDebounced();
    });

    $('#ss_scene_request').on('input', function () {
        getSettings().sceneRequest = String($(this).val());
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

    $('#gr_roster_note').on('input', function () {
        const stage = getSettingsStage();

        if (!stage) {
            return;
        }

        stage.note = String($(this).val());
        saveStage(getSettingsGroupId());
        // The chat is holding this text while the toggle is on, and the toggle
        // greys out for a group with no note at all.
        syncNoteToChat();
        refreshPanel();
    });

    $('#gr_layout_select').on('change', async function () {
        const stage = getSettingsStage();

        if (!stage) {
            return;
        }

        stage.activeLayoutId = String($(this).val());
        saveStage(getSettingsGroupId());

        // Only the open group can be muted from here; another group's layout
        // takes hold the next time a chat of that group starts. Its note is the
        // same story: only the open chat is holding one right now.
        if (getSettingsGroupId() === getCurrentGroup()?.id) {
            syncNoteToChat();
            await applyLayoutMutes();
        }

        renderSettings();
        refreshPanel();
    });

    $('#gr_layout_new').on('click', async () => {
        const stage = getSettingsStage();

        if (!stage) {
            toastr.warning(t`Create a group chat first.`);
            return;
        }

        const name = await Popup.show.input(t`New layout`, t`Name for the new layout`, '');

        if (!name) {
            return;
        }

        /** @type {Layout} */
        const layout = { id: uuidv4(), name: String(name).trim(), note: '', narrator: '', order: [], cards: {} };

        // Seeded from who is in the scene right now, so a new layout starts out
        // doing what the group already does and is edited down from there.
        const group = getSettingsGroup();

        for (const avatar of group?.members ?? []) {
            if (!group.disabled_members?.includes(avatar)) {
                layout.cards[avatar] = { active: true, greets: true, greeting: null };
            }
        }

        stage.layouts.push(layout);
        stage.activeLayoutId = layout.id;
        saveStage(getSettingsGroupId());
        renderSettings();
        refreshPanel();
    });

    $('#gr_layout_rename').on('click', async () => {
        const layout = getSettingsLayout();

        if (!layout) {
            return;
        }

        const name = await Popup.show.input(t`Rename layout`, t`New name`, layout.name);

        if (!name) {
            return;
        }

        layout.name = String(name).trim();
        saveStage(getSettingsGroupId());
        renderLayoutSelect();
        refreshPanel();
    });

    $('#gr_layout_delete').on('click', async () => {
        const stage = getSettingsStage();
        const layout = getSettingsLayout();

        if (!stage || !layout) {
            return;
        }

        const confirmed = await Popup.show.confirm(t`Delete layout`, t`Delete "${layout.name}"?`);

        if (!confirmed) {
            return;
        }

        stage.layouts = stage.layouts.filter(x => x.id !== layout.id);
        stage.activeLayoutId = '';
        saveStage(getSettingsGroupId());
        renderSettings();
        refreshPanel();
    });

    $('#gr_layout_note').on('input', function () {
        const layout = getSettingsLayout();

        if (!layout) {
            return;
        }

        layout.note = String($(this).val());
        saveStage(getSettingsGroupId());
        // This note wins over the group's, so whichever is in play is what the
        // chat should be holding while the toggle is on.
        syncNoteToChat();
        refreshPanel();
    });

    $('#gr_layout_narrator').on('input', function () {
        const layout = getSettingsLayout();

        if (!layout) {
            return;
        }

        layout.narrator = String($(this).val());
        saveStage(getSettingsGroupId());
    });

    // Bound once to the container, which outlives the rows: sortable refreshes
    // its item list on mousedown, so rebuilding the matrix doesn't strand it.
    $('#gr_layout_cards').sortable({
        items: '> .gr-layout-row',
        handle: '.gr-layout-grip',
        axis: 'y',
        placeholder: 'gr-layout-placeholder',
        forcePlaceholderSize: true,
        delay: getSortableDelay(),
        stop: saveLayoutOrder,
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
    focusedAvatar = null;
    // The new chat brings its own toggle state; honour it before anything
    // repaints from it.
    syncNoteToChat();
    // Hand the drawer back to the open group; a hand-picked group only outlives
    // the chat it was picked during if the user picks it again.
    settingsGroupId = '';

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

// The viewer's home: flush with the right edge, 24px up from the bottom.
// The horizontal half is left to CSS, so the browser keeps the window in the
// corner through a resize, an orientation change or an iPad app switch without
// JavaScript having to catch up a frame later. The vertical half cannot be:
// iOS resolves `bottom` on a fixed element against the layout viewport, which
// runs on under the browser chrome, and the window disappears behind it.
function getSpawnTop(height) {
  return Math.max(0, window.innerHeight - height - 24);
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
    bottom: "auto",
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

// Send the viewer home: pinned to the right edge in CSS, sat on a top the
// current viewport height decides.
function anchorViewerToSpawn($win) {
  $win.data(FOLLOW_SPAWN_KEY, true);
  $win.removeData(ANCHOR_KEY);
  $win.css({
    top: `${getSpawnTop($win.outerHeight())}px`,
    left: "auto",
    right: "0px",
    bottom: "auto",
  });
}

// Swaps the edge pinning for explicit top/left pixels. Drag and resize both
// move a window by its top-left corner, which a right/bottom pin would fight.
function pinViewerToPixels($win) {
  const style = window.getComputedStyle($win[0]);
  let top = parseFloat(style.top);
  let left = parseFloat(style.left);
  if (!Number.isFinite(top) || !Number.isFinite(left)) {
    const rect = $win[0].getBoundingClientRect();
    top = rect.top;
    left = rect.left;
  }
  $win.css({ top: `${top}px`, left: `${left}px`, right: "auto", bottom: "auto" });
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

// Whoever last took a turn, ignoring the user's own messages and system ones.
function getLastSpeakerAvatar(ctx) {
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];

  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i];
    if (!message || message.is_user || message.is_system) continue;
    if (message.original_avatar) return message.original_avatar;

    // Messages written before original_avatar existed only carry a name.
    const byName = (ctx.characters || []).find((c) => c.name === message.name);
    if (byName) return byName.avatar;
  }

  return null;
}

// The member the group loop has just handed the turn to, held from the moment
// they are drafted until their reply lands, so the viewer changes over as the
// turn starts rather than when the response has finished generating.
let draftedAvatar = null;

// A group chat has no characterId, so resolve its members instead.
function getActiveCharacters(ctx) {
  if (!ctx) return [];
  const allCharacters = ctx.characters || [];

  if (ctx.groupId) {
    const members = findGroup(ctx)?.members;
    if (!Array.isArray(members)) return [];

    // Show one member's images rather than the whole group's: a roster pin wins,
    // then whoever is taking the turn right now, then whoever spoke last. All
    // three are checked against the member list, so a pin or a speaker who has
    // since left the group falls through to the group as a whole — as does a
    // chat where nobody has spoken yet.
    const only = [focusedAvatar, draftedAvatar, getLastSpeakerAvatar(ctx)].find(
      (avatar) => avatar && members.includes(avatar),
    );

    return (only ? [only] : members)
      .map((avatar) => allCharacters.find((c) => c.avatar === avatar))
      .filter(Boolean);
  }

  const id = ctx.characterId;
  if (id === undefined || id === null || id === "") return [];
  const char = allCharacters[id];
  return char ? [char] : [];
}

function getActiveLabel(ctx) {
  const active = getActiveCharacters(ctx);
  if (ctx?.groupId && active.length !== 1) return findGroup(ctx)?.name || "Group";
  return active[0]?.name || "";
}

// Identity that survives characterId reshuffles, so we only reset on real changes.
function getContextKey(ctx) {
  if (!ctx) return null;
  if (ctx.groupId) return `group:${ctx.groupId}`;
  const id = ctx.characterId;
  if (id === undefined || id === null || id === "") return null;
  return `char:${(ctx.characters || [])[id]?.avatar ?? id}`;
}

/**
 * Which cast the viewer is showing, as an identity that survives a rescan:
 * one member's avatar when a group resolves to a single speaker, the group
 * itself when it doesn't, and the character in a solo chat.
 */
function getViewerIdentityKey(ctx) {
  const active = getActiveCharacters(ctx);
  if (ctx?.groupId) {
    return active.length === 1
      ? `member:${active[0].avatar}`
      : `group:${ctx.groupId}`;
  }
  return active[0]?.avatar ? `char:${active[0].avatar}` : null;
}

// The image each cast was last left on, so a cast that comes back — a member
// who speaks again, or the one character in a solo chat once their turn lands —
// returns to where you were instead of to the top of its list. URLs rather than
// indices, because a rescan can reorder or resize the list. Session-only, and
// dropped whenever the chat context changes.
const lastViewedByIdentity = new Map();
let viewerIdentityKey = null;

// Where `key` left the viewer, or -1 if nothing is remembered or the image it
// was on is no longer in the list.
function recallViewedIndex(key, images) {
  const url = key ? lastViewedByIdentity.get(key) : null;
  return url ? images.indexOf(url) : -1;
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
  // Remembered on show rather than at handoff, so the last thing on screen is
  // what comes back even if the turn ends without another rescan.
  if (viewerIdentityKey) lastViewedByIdentity.set(viewerIdentityKey, list[index]);

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

    const top = getSpawnTop(winH);

    const html = `
          <div id="${SINGLE_VIEWER_ID}" class="civ-window-frameless"
               style="top: ${top}px; right: 0; width: ${winW}px; height: ${winH}px;">
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

    // Draggable & Resizable (locked to aspect ratio)
    if ($.fn.draggable)
      $win.draggable({
        handle: ".civ-drag-handle",
        containment: "window",
        start: function () {
          pinViewerToPixels($(this));
        },
        stop: function () {
          $(this).data(FOLLOW_SPAWN_KEY, false);
          rememberAnchor($(this));
        },
      });
    if ($.fn.resizable)
      $win.resizable({
        handles: "se",
        aspectRatio: aspectRatio,
        // The handle drags the bottom-right corner, so the window has to be
        // held by its top-left one while it is being resized.
        start: function () {
          pinViewerToPixels($(this));
        },
        stop: function () {
          const $this = $(this);
          if ($this.data(FOLLOW_SPAWN_KEY)) anchorViewerToSpawn($this);
          else rememberAnchor($this);
        },
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
// Shared by the viewer's round button and the roster footer's: reuse the last
// scan when there is one, otherwise scan now and report what it found.
function openGallery() {
  if (lastScannedImages.length > 0) {
    spawnGalleryWindow(lastScannedImages, lastScannedCharName);
  } else {
    performScan();
  }
}

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
  lastViewedByIdentity.clear();
  viewerIdentityKey = null;
  draftedAvatar = null;
  if (key === null) return;

  const result = scanAndGetImages();
  // Set before the window opens, so the image it lands on is what gets
  // remembered for this cast.
  viewerIdentityKey = getViewerIdentityKey(ctx);
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

/**
 * A member has been drafted to speak. Switching here rather than on the
 * rendered message means the images change as the turn opens, not once the
 * reply is complete.
 * @param {number} chId Index into the character list
 */
function handleMemberDrafted(chId) {
  const avatar = (getSTContext()?.characters || [])[chId]?.avatar;
  if (!avatar || avatar === draftedAvatar) return;
  draftedAvatar = avatar;
  refocusViewer();
}

// The turn is over: hand the viewer back to ordinary last-speaker resolution,
// which lands on this same member when they actually posted, and on the
// previous one when the generation was aborted.
function clearDraftedAvatar() {
  draftedAvatar = null;
}

function handleMessageSwiped(mesId) {
  if (Number(mesId) !== 0) return;
  retargetToGreeting();
}

/**
 * The image source may have changed — a different character is being shown — so
 * the viewer re-aims at whatever the incoming cast was last left on, and at the
 * top of the list for a cast that has not been seen yet. A closed viewer is
 * left closed: only a context change opens one uninvited.
 */
function refocusViewer() {
  if (lastContextKey === null) return;

  const ctx = getSTContext();
  const result = scanAndGetImages();
  if (!result) return;

  // Pick up where this cast was left rather than at the top of its list: in a
  // group the turn passes between casts, and in a solo chat the list never
  // changed at all, so a finished turn should not undo browsing either.
  const nextKey = getViewerIdentityKey(ctx);
  const startIndex = Math.max(0, recallViewedIndex(nextKey, result.images));
  viewerIdentityKey = nextKey;

  if (viewerState && $(`#${SINGLE_VIEWER_ID}`).length > 0) {
    if (result.images.length === 0) {
      closeViewer();
    } else {
      viewerState.images = result.images;
      viewerState.failures = 0;
      updateImage(startIndex);
    }
  }

  if ($(`#${GALLERY_ID}`).length > 0) {
    spawnGalleryWindow(result.images, result.charName);
  }
}

// Card edits and group membership changes alter the image list in place.
function handleContentUpdate() {
  if (lastContextKey === null) return;
  const ctx = getSTContext();
  const result = scanAndGetImages();
  if (!result) return;

  // A membership edit can hand the viewer to a different cast without a turn.
  viewerIdentityKey = getViewerIdentityKey(ctx);

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
      // A window still in its spawn spot holds its own right edge; only the
      // top has to be recomputed for the new viewport height.
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
    eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, handleMemberDrafted);
    eventSource.on(eventTypes.GENERATION_ENDED, clearDraftedAvatar);
    eventSource.on(eventTypes.GENERATION_STOPPED, clearDraftedAvatar);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, refocusViewer);
    eventSource.on(eventTypes.MESSAGE_DELETED, refocusViewer);
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
    mountAssistBar();
    watchManualNoteEdits();

    eventSource.on(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, applyLayoutGreeting);
    eventSource.on(event_types.GROUP_CHAT_CREATED, openSceneFromLayout);
    eventSource.on(event_types.APP_READY, pruneOrphanStages);
    eventSource.on(event_types.APP_READY, () => refreshWorlds());
    // A card's world can change in ST too (and a deleted card leaves its world).
    eventSource.on(event_types.CHARACTER_EDITED, syncWorldGroupsSoon);
    eventSource.on(event_types.CHARACTER_DELETED, syncWorldGroupsSoon);
    eventSource.on(event_types.CHARACTER_RENAMED, renameInStages);
    eventSource.on(event_types.APP_READY, () => {
        // Extension-GroupGreetings listens to the same event and overwrites the
        // greeting for any card with a group-greeting pool — the exact cards a
        // layout pins. makeLast only moves this listener behind the ones already
        // registered, so it has to run once every extension has loaded.
        eventSource.makeLast(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, applyLayoutGreeting);
    });
    eventSource.on(event_types.CHAT_CHANGED, syncPanelToChat);
    eventSource.on(event_types.GROUP_UPDATED, refreshPanel);
    eventSource.on(event_types.GENERATION_ENDED, refreshPanel);
    eventSource.on(event_types.GENERATION_STOPPED, refreshPanel);

    initImages();
});
