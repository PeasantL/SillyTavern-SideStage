/**
 * SideStage — the right-hand strip: who is in the scene, whose turn it is, and
 * what the scene looks like.
 *
 * Merged from two extensions, Group Roster (the cast list, turn controls and
 * Author's Note) and Character Image Viewer (the image viewer and its
 * gallery), now sections of one strip. The two halves keep their original accessors on purpose — the
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
// Read as a namespace, so a SillyTavern without worldInfoCache or reloadEditor
// still loads SideStage (see refreshCachedLorebooks()).
import * as worldInfo from '../../../world-info.js';
import { waitUntilCondition } from '../../../utils.js';
import { t } from '../../../i18n.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

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
 * @property {boolean} active Whether the card is in the scene (unmuted) while this layout is selected. Everyone
 *     in the scene has a turn in the opening.
 * @property {string} text The card's turn: what it posts when a new chat opens with this layout. Written for
 *     this layout alone (it follows on from the turns before it), so it lives here rather than in the card.
 *     Blank posts nothing.
 */

/**
 * A way to open a scene with this group's cast. Card order is the group's, so
 * a layout only stores what varies: who is in it, who speaks, and with what.
 * @typedef {object} Layout
 * @property {string} id
 * @property {string} name
 * @property {string} note Author's Note for this scene; blank falls back to the group's
 * @property {string} narrator Scene-setting text posted before the turns; blank for none
 * @property {string[]} order Avatar file names, in the order the scene opens
 * @property {Record<string, LayoutEntry>} cards Keyed by avatar file name; absent means muted
 */

/**
 * What SideStage keeps for one group. The cast is the group's own member list,
 * and who is in the scene is who is unmuted, so neither is stored here.
 *
 * Only a world's group has one, kept in the world's lorebook (see the Worlds
 * region) with `group` naming the group. Other groups have no layouts or note.
 * @typedef {object} Stage
 * @property {string} note Author's Note the footer toggle fills the chat with
 * @property {Layout[]} layouts Scenes that can be opened with this cast
 * @property {string} [group] Id of the world's group
 * @property {number} [rev] Raised by every save, by SideStage or the Character Editor, so a save can tell the
 *     file changed since it was read (see mergeStage())
 */

const rosterDefaults = {
    /**
     * Whether an OOC / Morality / Scene exchange is ghosted once it lands —
     * ST's own "Exclude message from prompts" — so it stays on screen but
     * never reaches a later reply. Toggled from the button row.
     * @type {boolean}
     */
    oocGhost: true,
    /**
     * What the Morality and Scene buttons ask, inside the fixed
     * [OOC: Pause the roleplay and respond out of character. ...] wrapper.
     * Blank falls back to these defaults.
     * @type {string}
     */
    moralityRequest: 'Describe the evil of the current scene in detail.',
    sceneRequest: 'Describe the current scene in detail.',
    /**
     * Locks what the Character Editor manages (see the Character Editor lock):
     * card fields, new cards, import, rename, duplicate and delete, and worlds' lorebooks
     * and groups. The controls stay, greyed out.
     * @type {boolean}
     */
    lockManaged: true,
    /**
     * The Character Editor's address as this browser opens it (e.g.
     * https://host:1019/). Set, the lock's messages, the World Info notice, the
     * layout picker and the drawer link into it; blank, there are no links.
     * @type {string}
     */
    editorUrl: '',
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
    // Which layout is selected is the group's (see getActiveLayout()); stages
    // saved before kept it here, and the next save drops it.
    delete stage.activeLayoutId;

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
    // Only worlds' groups have layouts and a note now (kept in the lorebook);
    // drop the ones ordinary groups kept here.
    delete settings.groups;

    return settings;
}

/** Name of the browser tab links into the Character Editor open in, so they reuse one tab. */
const EDITOR_WINDOW = 'character-editor';

/**
 * A link into the Character Editor, or '' when its address isn't set. The
 * editor reads what to open from the hash: `card` (a card file), or `world`
 * and maybe `layout` (an id).
 * @param {{card?: string, world?: string, layout?: string}} [to] Nothing opens the editor as it is
 * @returns {string}
 */
function editorLink(to = {}) {
    const base = String(getSettings().editorUrl ?? '').trim();

    if (!base) {
        return '';
    }

    try {
        const url = new URL(base, location.href);
        url.hash = new URLSearchParams(Object.entries(to).filter(([, value]) => value)).toString();
        return url.href;
    } catch {
        return '';
    }
}

/**
 * Opens the Character Editor on a card, world or layout (see editorLink()).
 * @param {{card?: string, world?: string, layout?: string}} [to]
 */
function openInEditor(to = {}) {
    const href = editorLink(to);

    if (href) {
        window.open(href, EDITOR_WINDOW);
    }
}

/** Shows the links into the Character Editor only while its address is set. */
function applyEditorLinks() {
    document.body.classList.toggle('ss-editor-linked', !!editorLink());
}

/**
 * The stage of one group, kept in its world's lorebook.
 * @param {string} [groupId]
 * @returns {Stage|null} Null for no group, a group not tied to a world, or while that isn't known yet.
 */
function getStage(groupId) {
    const world = groupId ? getGroupWorld(groupId) : '';
    return world ? worldStages.get(world) ?? null : null;
}

/** @returns {Stage|null} The stage of the open group chat. */
function getActiveStage() {
    return getStage(getCurrentGroup()?.id);
}

/** @returns {object[]} The groups tied to a world: the only ones with layouts and a note. */
function getWorldGroups() {
    return groups.filter(x => getGroupWorld(x.id));
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

/** @returns {Stage|null} The stage the settings drawer edits. */
function getSettingsStage() {
    return getStage(getSettingsGroupId());
}

/** Field of a world's group (in ST's group file) naming its selected layout. */
const GROUP_LAYOUT_KEY = 'sidestage_layout';

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
function getActiveLayout(groupId) {
    const id = getSelectedLayoutId(groups.find(x => x.id === groupId));
    return (id && getStage(groupId)?.layouts.find(x => x.id === id)) || null;
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
    return layout.cards[avatar] ?? { active: false, text: '' };
}

/**
 * A card's turn in a layout's opening (blank: it posts nothing).
 * @param {LayoutEntry} entry
 * @returns {string}
 */
function getTurnText(entry) {
    return typeof entry.text === 'string' ? entry.text : '';
}

// #region Worlds

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

/** @returns {boolean} Whether a lorebook is a world: it carries SideStage's key. */
function isWorldLorebook(data) {
    const stage = data?.extensions?.[WORLD_KEY];
    return Boolean(stage && typeof stage === 'object');
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
 * are kept. Changes are kept per field: the group's note,
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

    if (local.note !== base.note) {
        merged.note = local.note;
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
async function pullWorldStage(world, given) {
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
    const layout = getActiveLayout(groupId);
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
                await refreshCachedLorebooks();
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
            applyLock();
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
function onBackToTab() {
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
 * picked to reply, and can't be given a forced turn.
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
function applyLayoutGreeting(args) {
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
function quietOtherGreetingPickers() {
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
async function openSceneFromLayout() {
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

/**
 * Headroom over the source, so a rewrite is never clipped mid-sentence. The
 * flat 2048 on top is for a profile that thinks first: its reasoning comes out
 * of this same budget. 8192 is the most some providers accept at all.
 */
function assistBudget(text) {
    return Math.min(8192, Math.ceil(String(text ?? '').length / 2) + 256 + 2048);
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
        // No overrides: the request runs with the profile's own preset, so its
        // reasoning settings hold here too. Whatever thinking comes back in the
        // body is stripped by cleanAssistOutput / previewAssistOutput.
        const stream = Boolean(onProgress);
        const result = await service.sendRequest(profile.id, prompt, maxTokens, { stream });

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
 * The OOC / Morality / Scene buttons send their line exactly the way a Quick
 * Reply does: it goes into the message box and Send is clicked, so the answer
 * is an ordinary Generate() turn — same prompt, same context, same streaming.
 */

// How long a turn may take before the Ghost toggle stops waiting on it.
const OOC_TURN_TIMEOUT = 10 * 60 * 1000;

/**
 * Sends an OOC line through the message box, as Quick Reply does, and — with
 * the Ghost toggle on — ghosts the exchange once the reply has landed.
 * @param {string} oocLine
 * @returns {Promise<void>}
 */
async function runOocTurn(oocLine) {
    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
    const sendButton = /** @type {HTMLElement} */ (document.getElementById('send_but'));

    if (!textarea || !sendButton) {
        return;
    }

    // The ask lands at the end of the chat, and whatever answers it after.
    const askMessageId = chat.length;

    textarea.value = substituteParams(oocLine);
    textarea.focus();
    sendButton.click();

    if (!getSettings().oocGhost) {
        return;
    }

    // With the Ghost toggle on, the whole exchange is ghosted — the same
    // "Exclude message from prompts" state the mes_hide button sets — so it
    // stays visible but never bleeds into a later reply.
    try {
        await waitUntilCondition(() => isGenerating() || chat.length > askMessageId, 10000, 50);
        await waitUntilCondition(() => !isGenerating(), OOC_TURN_TIMEOUT, 200);
    } catch {
        return;
    }

    if (chat.length > askMessageId) {
        await hideChatMessageRange(askMessageId, chat.length - 1, false);
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

    await runOocTurn(`[OOC: Pause the roleplay and respond out of character: ${input}]`);
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
    return `[OOC: Pause the roleplay and respond out of character. ${request}]`;
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

// The strip: one fixed column on the right edge holding everything SideStage
// shows — the roster, the gallery and the image — stacked as sections of one
// panel rather than as separate windows. Sections mount into it as they open;
// it goes away with its last one. Their order on screen is set in style.css,
// so the order they happen to open in does not matter.
const STRIP_ID = 'sideStage';

function mountInStrip(html) {
    let $strip = $(`#${STRIP_ID}`);
    if (!$strip.length) {
        $strip = $(`<div id="${STRIP_ID}" class="ss-strip"></div>`).appendTo('body');
        // Catches a #sheld that moved without resizing (a class toggled on body).
        measureStrip();
    }
    return $(html).appendTo($strip);
}

function pruneStrip() {
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
function watchStrip() {
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
                <textarea id="gr_roster_note" class="text_pole textarea_compact ss-readonly" rows="3" readonly
                          placeholder="None yet. Filled into this chat's Author's Note when the panel toggle is on"></textarea>
                <div class="flex-container alignItemsCenter">
                    <small class="ss-settings-hint flex1">The note and the layouts are written in the Character Editor's World section.</small>
                    <div id="gr_world_open" class="menu_button menu_button_icon interactable ss-editor-link" title="Open this world in the Character Editor">
                        <i class="fa-solid fa-pen-to-square fa-fw"></i>
                    </div>
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

function renderSettings() {
    if (!document.getElementById('gr_group_select')) {
        return;
    }

    renderGroupSelect();
    renderWorldRow();
    $('#gr_roster_note').val(getSettingsStage()?.note ?? '').prop('disabled', !getSettingsStage());
    $('#ss_editor_url').val(getSettings().editorUrl ?? '');
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

// --- 2. SETTINGS ---
const imageDefaults = Object.freeze({
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
  // The viewer always opens by itself now (it is the only way in to it).
  delete imageSettings.autoOpen;
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
// Both are sections of the strip (see mountInStrip()). The gallery takes the
// roster's place while it is open — a drill-down you open, pick from and
// dismiss — and closing it brings the roster back.
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
      <div id="${GALLERY_ID}" class="ss-section civ-gallery">
          <div class="civ-header">
              <span>Gallery: ${escapeHtml(charName)} (${images.length})</span>
              <div class="civ-close-btn gr-header-btn fa-solid fa-circle-xmark fa-fw interactable"
                   role="button" tabindex="0" aria-label="Close gallery" title="Close"></div>
          </div>
          <div class="civ-gallery-body">
              <div class="civ-gallery-grid">${gridHtml}</div>
          </div>
      </div>`;

  const $win = mountInStrip(html);

  const close = () => {
    $win.remove();
    pruneStrip();
  };
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
  pruneStrip();
}

function closeAllWindows() {
  $(`#${SINGLE_VIEWER_ID}, #${GALLERY_ID}`).remove();
  viewerState = null;
  pruneStrip();
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
}

// ──────────────────────────────────────────────
//  SINGLETON viewer: the strip's image slot, a fixed size (style.css).
//  If it already exists, just switch the image.
// ──────────────────────────────────────────────
function spawnSingleImageWindow(startIndex, allImages) {
  if (!Array.isArray(allImages) || allImages.length === 0) return;

  // ── Singleton: reuse existing section ──
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

  const html = `
      <div id="${SINGLE_VIEWER_ID}" class="ss-section civ-viewer">
          <div class="civ-overlay-container">
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
              <img id="civ-target-img" alt="Character image" />
          </div>
      </div>`;

  const $win = mountInStrip(html);
  const $img = $win.find("#civ-target-img");

  // ── Store singleton state before wiring handlers that read it ──
  viewerState = {
    $win,
    $img,
    index: currentIndex,
    images: allImages,
    failures: 0,
  };

  $img.on("load", () => {
    if (viewerState) viewerState.failures = 0;
  });
  // Skip past dead links instead of showing a broken image.
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

  $win
    .find(".civ-gallery-btn-round")
    .on("click", openGallery)
    .on("keydown", (e) => {
      if (isActivationKey(e)) {
        e.preventDefault();
        openGallery();
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

  updateImage(currentIndex);
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
// Escape closed the image section: keep it closed until the chat changes,
// rather than bringing it back on the next turn.
let viewerDismissed = false;

/**
 * Points the image section at a fresh scan. It follows the cast: opened when
 * the character on stage has images (and auto-open is on), closed when they
 * have none, so in a group it comes and goes with the turn.
 * @param {{images: string[]}} result Scan result
 * @param {number} index Image to land on
 */
function showImages(result, index) {
  const open = viewerState && $(`#${SINGLE_VIEWER_ID}`).length > 0;
  if (result.images.length === 0) {
    if (open) closeViewer();
  } else if (open) {
    viewerState.images = result.images;
    viewerState.failures = 0;
    updateImage(index);
  } else if (!viewerDismissed) {
    spawnSingleImageWindow(index, result.images);
  }
}

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
  viewerDismissed = false;
  if (key === null) return;

  const result = scanAndGetImages();
  // Set before the window opens, so the image it lands on is what gets
  // remembered for this cast.
  viewerIdentityKey = getViewerIdentityKey(ctx);
  if (result && result.images.length > 0) {
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
 * top of the list for a cast that has not been seen yet.
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

  showImages(result, startIndex);

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

  showImages(result, viewerState ? viewerState.index : 0);

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
    viewerDismissed = true;
    closeViewer();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    updateImage(viewerState.index - 1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    updateImage(viewerState.index + 1);
  }
});

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

// ══════════════════════ Tablet layout ═══════════════════════

// Any iPad, in either orientation: a touch screen at least 744px both ways (an
// iPad mini is 744 wide in portrait), up to 1420px wide. Phones fail the
// height or the width, and a mouse-only desktop window fails the pointer, so
// neither is touched however narrow it gets. any-pointer rather than pointer:
// with a Magic Keyboard or trackpad attached, an iPad's primary pointer turns
// fine and the whole layout would drop back to desktop.
const TABLET_QUERY = '(any-pointer: coarse) and (min-width: 744px) and (min-height: 744px) and (max-width: 1420px)';

// Core's touch layout lives in one @media block in mobile-styles.css that
// stops at 1000px, so an iPad gets it in portrait and loses it in landscape.
// A copy of that block under the tablet query is added at page load, from
// core's live rules — so it keeps up with SillyTavern updates, where a
// hand-made copy (what user.css used to carry) goes stale: it had already
// missed the background-folder and multi-select rules added since it was
// taken.
//
// The copy goes at the very end of the sheet, which is where user.css's copy
// sat in the cascade (after all of core's CSS). Not straight after the
// original: the sheet ends with an iOS-only block, @supports
// (-webkit-touch-callout: none), whose `.drawer-content { top: 0; margin-top:
// 36px }` then wins, and on top of user.css's PWA `top` it opened every drawer
// 36px below the chat's top. That block never applies in desktop or emulated
// WebKit, which is why only the real iPad showed it.
//
// Inserted rather than adding the query to the original's media list: Safari
// did not apply a media list edited in place, and insertRule always restyles.
// Rule by rule into an empty block, so one rule an engine won't re-parse from
// its own serialisation costs that rule, not the whole layout. Found by its
// width rather than its exact text, which engines serialise differently; the
// landscape-only block is skipped by its orientation.
function stretchMobileLayout() {
    const sheet = [...document.styleSheets].find(s => s.href?.endsWith('/css/mobile-styles.css'));
    const rules = sheet ? [...sheet.cssRules] : [];
    const source = rules.find(rule => rule instanceof CSSMediaRule
        && /max-width:\s*1000px/.test(rule.media.mediaText)
        && !/orientation/.test(rule.media.mediaText));
    if (!source) {
        console.warn('[SideStage] Core touch layout not found; tablet landscape keeps the desktop layout.');
        return;
    }
    const copy = sheet.cssRules[sheet.insertRule(`@media screen and ${TABLET_QUERY} {}`, sheet.cssRules.length)];
    const skipped = [];
    for (const rule of source.cssRules) {
        try {
            copy.insertRule(rule.cssText, copy.cssRules.length);
        } catch {
            skipped.push(rule.cssText.split('{')[0].trim());
        }
    }
    if (skipped.length) {
        console.warn('[SideStage] Tablet layout skipped rules this browser would not re-parse:', skipped);
    }
}

// body.ss-tablet gates the column reserve in style.css. Followed live, so
// plugging in a mouse or a window change re-decides it.
function watchTablet() {
    const tablet = window.matchMedia(TABLET_QUERY);
    const apply = () => document.body.classList.toggle('ss-tablet', tablet.matches);
    tablet.addEventListener('change', apply);
    apply();
}

// The status bar of SillyTavern as a home-screen web app: iPadOS paints it
// from <meta name="theme-color">, which SillyTavern sets to the theme's Blur
// Tint on every theme load (applyThemeColor('blurTint') in power-user.js), so
// it came out in the tint rather than black. Held at black here, only in the
// web app (a browser tab keeps SillyTavern's own colour). The meta's first
// value and the bar's style (`black`) are in index.html, read before any
// script runs, so those stay with whoever serves SillyTavern.
const STATUS_BAR_COLOR = '#000000';

function pinStatusBar() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!standalone || !meta) {
        return;
    }
    const pin = () => {
        if (meta.getAttribute('content') !== STATUS_BAR_COLOR) {
            meta.setAttribute('content', STATUS_BAR_COLOR);
        }
    };
    new MutationObserver(pin).observe(meta, { attributes: true, attributeFilter: ['content'] });
    pin();
}

// ═══════════════════ Character Editor lock ═══════════════════

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
function applyLock() {
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
function lockCommands() {
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

function watchLock() {
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

// ═══════════════════════════ Boot ═══════════════════════════

jQuery(async () => {
    stretchMobileLayout();
    watchTablet();
    pinStatusBar();
    watchStrip();
    getSettings();
    // Before addSettings(), which paints the image checkboxes from it.
    loadImageSettings(getSTContext());
    addSettings();
    applyEditorLinks();
    addWandButton();
    mountAssistBar();
    watchManualNoteEdits();
    watchLock();

    eventSource.on(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, applyLayoutGreeting);
    eventSource.on(event_types.GROUP_CHAT_CREATED, openSceneFromLayout);
    eventSource.on(event_types.APP_READY, () => refreshWorlds());
    eventSource.on(event_types.APP_READY, lockCommands);
    // A group or lorebook may have become (or stopped being) a world's, and the panels open on new ones.
    eventSource.on(event_types.CHAT_CHANGED, applyLock);
    eventSource.on(event_types.GROUP_UPDATED, applyLock);
    eventSource.on(event_types.WORLDINFO_UPDATED, applyLock);
    document.addEventListener('visibilitychange', onBackToTab);
    // Two windows side by side never change visibility: coming back is a focus.
    window.addEventListener('focus', onBackToTab);
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
        quietOtherGreetingPickers();
    });
    eventSource.on(event_types.CHAT_CHANGED, syncPanelToChat);
    eventSource.on(event_types.GROUP_UPDATED, refreshPanel);
    eventSource.on(event_types.GENERATION_ENDED, refreshPanel);
    eventSource.on(event_types.GENERATION_STOPPED, refreshPanel);

    initImages();
});
