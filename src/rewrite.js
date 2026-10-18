/**
 * The button row above the message box: Perspective, Directive and Spell check rewrites, and the OOC asides.
 */
import { isGenerating, saveSettingsDebounced, chat, updateMessageBlock, messageFormatting, scrollChatToBottom, substituteParams, generateRaw, name1, system_message_types, saveChatConditional, ensureSwipes, syncMesToSwipe, syncSwipeToMes, refreshSwipeButtons } from '../../../../../script.js';
import { getMessageTimeStamp } from '../../../../RossAscends-mods.js';
import { hideChatMessageRange } from '../../../../chats.js';
import { parseReasoningFromString } from '../../../../reasoning.js';
import { waitUntilCondition } from '../../../../utils.js';
import { t } from '../../../../i18n.js';
import { getSettings, rosterDefaults } from './settings.js';

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
export function mountAssistBar() {
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
