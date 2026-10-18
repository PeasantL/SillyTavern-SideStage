/**
 * Small helpers both halves use: the open group, characters by avatar, escaping, debouncing.
 */
import { characters } from '../../../../../script.js';
import { groups, selected_group } from '../../../../group-chats.js';

/** @returns {object|null} The currently open group, or null if not in a group chat. */
export function getCurrentGroup() {
    if (!selected_group) {
        return null;
    }
    return groups.find(x => x.id === selected_group) ?? null;
}

/** @returns {object|undefined} Character object for an avatar file name. */
export function getCharacterByAvatar(avatar) {
    return characters.find(x => x.avatar === avatar);
}

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Card data is untrusted: anything interpolated into markup goes through this.
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function getSTContext() {
  if (typeof SillyTavern === "undefined" || !SillyTavern.getContext)
    return null;
  return SillyTavern.getContext();
}

export function isEditableTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    el.isContentEditable === true
  );
}

export function isActivationKey(e) {
  return e.key === "Enter" || e.key === " " || e.key === "Spacebar";
}
