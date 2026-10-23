/**
 * SideStage's settings (extension_settings.groupRoster) and links into the Character Editor.
 */
import { extension_settings } from '../../../../extensions.js';

const MODULE_NAME = 'groupRoster';
export const rosterDefaults = {
    /**
     * Whether an OOC / Morality / Scene exchange is ghosted once the next ordinary turn starts —
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
     * The name of the group member who answers the OOC / Morality / Scene
     * asides, as a forced turn, so a swipe asks them again. Muted members
     * still answer. No member by that name, and SideStage's own narrator card
     * answers where the group has it (every world's group does). Blank, and the
     * aside goes out like a Quick Reply and whoever the group picks answers.
     * @type {string}
     */
    oocNarrator: 'Narrator',
    /**
     * What the narrator says when the roster brings a member into the scene
     * (before their turn) or sends one off (after it). {{char}} is them.
     * Blank falls back to these defaults.
     * @type {string}
     */
    enterLine: '{{char}} entered the scene.',
    exitLine: '{{char}} left the scene.',
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

export function getSettings() {
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
export const EDITOR_WINDOW = 'character-editor';

/**
 * A link into the Character Editor, or '' when its address isn't set. The
 * editor reads what to open from the hash: `card` (a card file), or `world`
 * and maybe `layout` (an id).
 * @param {{card?: string, world?: string, layout?: string}} [to] Nothing opens the editor as it is
 * @returns {string}
 */
export function editorLink(to = {}) {
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
export function openInEditor(to = {}) {
    const href = editorLink(to);

    if (href) {
        window.open(href, EDITOR_WINDOW);
    }
}

/** Shows the links into the Character Editor only while its address is set. */
export function applyEditorLinks() {
    document.body.classList.toggle('ss-editor-linked', !!editorLink());
}
