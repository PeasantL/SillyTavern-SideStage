/**
 * A world's stage (its group's note and greeting layouts, kept in the lorebook as extensions.sidestage):
 * its shape, filling in, and the three-way merge shared with the Character Editor. No SillyTavern imports, so
 * tests/merge.test.mjs can import it as it is.
 */

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


/**
 * Fills in whatever a stage is missing, in place.
 * @param {object} stage
 * @returns {Stage}
 */
export function normalizeStage(stage) {
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
export function getLayoutOrder(group, layout) {
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
export function getLayoutEntry(layout, avatar) {
    return layout.cards[avatar] ?? { active: false, text: '' };
}

/**
 * A card's turn in a layout's opening (blank: it posts nothing).
 * @param {LayoutEntry} entry
 * @returns {string}
 */
export function getTurnText(entry) {
    return typeof entry.text === 'string' ? entry.text : '';
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
export function mergeStage(local, base, file) {
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
export function stageRev(stage) {
    return Number.isInteger(stage?.rev) ? stage.rev : 0;
}
