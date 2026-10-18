/**
 * SideStage — the right-hand strip: who is in the scene, whose turn it is, and
 * what the scene looks like.
 *
 * Merged from two extensions, Group Roster (the cast list, turn controls and
 * Author's Note) and Character Image Viewer (the image viewer and its
 * gallery), now sections of one strip. The roster half imports live bindings
 * from SillyTavern's modules; the image half reads SillyTavern.getContext().
 *
 * This file only starts it all; the parts are in src/: stage (the layouts and
 * their merge), settings, util, worlds (world groups and catching up with the
 * Character Editor), scene (mutes, openings, turns, Author's Note), rewrite
 * (the button row), panel (the strip and roster), drawer (settings), images,
 * tablet and lock (the Character Editor lock).
 */
import { eventSource, event_types } from '../../../../script.js';
import { applyEditorLinks, getSettings } from './src/settings.js';
import { getSTContext } from './src/util.js';
import { onBackToTab, refreshWorlds, renameInStages, syncWorldGroupsSoon } from './src/worlds.js';
import { applyLayoutGreeting, openSceneFromLayout, quietOtherGreetingPickers, watchManualNoteEdits } from './src/scene.js';
import { mountAssistBar } from './src/rewrite.js';
import { addWandButton, refreshPanel, syncPanelToChat, watchStrip } from './src/panel.js';
import { addSettings } from './src/drawer.js';
import { initImages, loadImageSettings } from './src/images.js';
import { pinStatusBar, stretchMobileLayout, watchTablet } from './src/tablet.js';
import { applyLock, lockCommands, watchLock } from './src/lock.js';

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
