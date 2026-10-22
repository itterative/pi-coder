import type { ClassifierAnswer, ClassifierQuestion } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { TodoItem } from "../todolist/parser";
import type { ReminderModelChoice } from "./scheduler";
import { todoItemsFrom } from "./session-signals";

/**
 * The TODO-specific query: one probability question per item the list has not marked in progress, plus one
 * for "outside the list".
 *
 * A win for an item means the work moved there without the list saying so, which is the moment the `todo`
 * reminder is for; a win for `outside`, a weak score, or a split answer leaves the list alone. The list's
 * statuses never reach the model — the candidates are chosen from them — so the question cannot be answered
 * by parroting the `in_progress` label; the model reads the request and the recent activity instead.
 *
 * One bool per item, not a single choice: a choice with the production-shaped active candidates came back
 * `none` on 12 of 15 recorded states, while the per-item bools stayed quiet on discussion turns and scored
 * the work item where the work existed.
 */

/** How many candidates one query asks about; the list allows 50 and the request should not carry them. */
export const MAX_TODO_QUERY_ITEMS = 4;

/**
 * The probability an item must reach, and beat the outside answer, to count as where the work moved.
 *
 * Lower than the reminder threshold's 0.45 on purpose: this is an item-match floor, not a "reminder worth
 * showing" probability. Live reads put a turn that was about its pending item at 0.32 against outside 0.24,
 * while an unrelated turn stayed at 0.06 against 0.27, so 0.30 separates the two without firing on the weak
 * scores the offline discussion turns produced (tables in `reminders/selection.md`).
 */
export const DEFAULT_TODO_MOVE_MIN_PROBABILITY = 0.3;

/** The question that catches work no item describes. */
export const TODO_QUERY_OUTSIDE_QUESTION = "todo_outside";

/** The most of a title the query carries; the parser allows 500 characters. */
const MAX_QUERY_TITLE_CHARS = 120;

/** The question id for one item; stable per item, so a debug entry can be read back. */
export function todoQueryQuestionId(itemId: string): string {
    return `todo_item_${itemId}`;
}

/** Criteria for one candidate item's question. */
export const TODO_MOVE_CRITERIA = {
    true: "Yes: this item is what the current work is about",
    false: "No: the work is on a different item, or on something outside the list",
} as const;

/** Criteria for the outside question; it is the veto the item scores have to beat. */
export const TODO_OUTSIDE_CRITERIA = {
    true: "Yes: no listed item matches the current work",
    false: "No: one of the listed items matches the current work",
} as const;

/** One built query: the questions to send, and the item each candidate question asks about. */
export interface TodoQuery {
    questions: Record<string, ClassifierQuestion>;
    /** Keyed by question id, so an answer can be mapped back to its item. */
    items: ReadonlyMap<string, TodoItem>;
}

/** The item a query read as the current work, and how strongly. */
export interface TodoMove {
    item: TodoItem;
    probability: number;
}

/**
 * Build the query for the items the list has not marked in progress.
 *
 * Work on the `in_progress` item was already said; only a move to a `pending` or `blocked` item is a
 * transition the list has not recorded. `undefined` means there is nothing the reminder could act on, so the
 * caller sends no extra questions.
 */
export function todoQueryFor(items: readonly TodoItem[]): TodoQuery | undefined {
    const candidates = items
        .filter((item) => item.status === "pending" || item.status === "blocked")
        .slice(0, MAX_TODO_QUERY_ITEMS);
    if (candidates.length === 0) {
        return undefined;
    }

    const questions: Record<string, ClassifierQuestion> = {};
    const byQuestion = new Map<string, TodoItem>();

    for (const item of candidates) {
        const questionId = todoQueryQuestionId(item.id);
        byQuestion.set(questionId, item);
        questions[questionId] = {
            type: "bool",
            instructions:
                "Is the current request and recent activity about this TODO.md item: " +
                `"${queryTitle(item.title)}"? Answer yes when the work has moved to this item, even if the ` +
                "list still marks another item in progress.",
            criteria: TODO_MOVE_CRITERIA,
        };
    }

    questions[TODO_QUERY_OUTSIDE_QUESTION] = {
        type: "bool",
        instructions:
            "Is the current request and recent activity about something outside the TODO.md list - " +
            "discussion, review, or work no item describes?",
        criteria: TODO_OUTSIDE_CRITERIA,
    };

    return { questions, items: byQuestion };
}

/** The TODO query for a branch, or `undefined` when the list has no item the work could move to. */
export function todoQueryFrom(entries: readonly SessionEntry[]): TodoQuery | undefined {
    const items = todoItemsFrom(entries);

    return items === undefined ? undefined : todoQueryFor(items);
}

/**
 * The item the work moved to, when a candidate's answer is strong enough and beats the outside answer.
 *
 * Ties go to `outside`, and so does a missing outside answer only when the item itself fell below the
 * threshold; an unreadable outside question is not allowed to veto an otherwise clear move. `undefined`
 * means the list stands.
 */
export function todoMoveFrom(
    answers: Readonly<Record<string, ClassifierAnswer>>,
    query: TodoQuery,
    minProbability: number = DEFAULT_TODO_MOVE_MIN_PROBABILITY,
): TodoMove | undefined {
    let best: TodoMove | undefined;

    for (const [questionId, item] of query.items) {
        const answer = answers[questionId];
        if (answer === undefined || answer.type !== "bool") {
            continue;
        }

        if (best === undefined || answer.probability > best.probability) {
            best = { item, probability: answer.probability };
        }
    }

    if (best === undefined || best.probability < minProbability) {
        return undefined;
    }

    const outside = answers[TODO_QUERY_OUTSIDE_QUESTION];
    if (
        outside !== undefined &&
        outside.type === "bool" &&
        outside.probability >= best.probability
    ) {
        return undefined;
    }

    return best;
}

/** The returned probability per candidate item id and for the outside question, for the debug entry. */
export function todoQueryScores(
    answers: Readonly<Record<string, ClassifierAnswer>>,
    query: TodoQuery,
): Record<string, number> {
    const scores: Record<string, number> = {};

    for (const [questionId, item] of query.items) {
        const answer = answers[questionId];
        if (answer?.type === "bool") {
            scores[item.id] = answer.probability;
        }
    }

    const outside = answers[TODO_QUERY_OUTSIDE_QUESTION];
    if (outside?.type === "bool") {
        scores.outside = outside.probability;
    }

    return scores;
}

/** What the TODO query contributes to one turn's reminder decision. */
export interface TodoVerdict {
    /** The effective choice: `todo` when a detected move outranks a `none` or unreadable answer. */
    choice?: ReminderModelChoice;
    /** The item the query read as where the work moved, for the debug entry. */
    move?: { id: string; probability: number };
    /** The query's returned scores, for the debug entry. */
    scores?: Record<string, number>;
}

/**
 * Weigh the query's answers against the model's reminder choice.
 *
 * A detected move outranks a deliberate `none` or an unreadable reminder answer, because the `todo` reminder
 * is what asks the agent to record it; an explicit pick of another reminder wins this turn, and the move
 * stays visible on the next one. The move and its scores are reported either way, so a debug entry shows
 * what the query read even when it did not win.
 */
export function todoChoiceFrom(
    query: TodoQuery | undefined,
    extras: Readonly<Record<string, ClassifierAnswer>> | undefined,
    choice: ReminderModelChoice | undefined,
): TodoVerdict {
    if (query === undefined || extras === undefined) {
        return { choice };
    }

    const scores = todoQueryScores(extras, query);
    const moved = todoMoveFrom(extras, query);
    if (moved === undefined) {
        return { choice, scores };
    }

    return {
        choice: choice === undefined || choice === "none" ? "todo" : choice,
        move: { id: moved.item.id, probability: moved.probability },
        scores,
    };
}

/** A title on one line and within the query's budget, so an instruction stays a sentence. */
function queryTitle(title: string): string {
    const collapsed = title.replace(/\s+/gu, " ").trim();

    return collapsed.length > MAX_QUERY_TITLE_CHARS
        ? `${collapsed.slice(0, MAX_QUERY_TITLE_CHARS - 1)}…`
        : collapsed;
}
