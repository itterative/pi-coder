import { describe, expect, it } from "vitest";
import type { ClassifierAnswer } from "@earendil-works/pi-ai";

import {
    DEFAULT_TODO_MOVE_MIN_PROBABILITY,
    MAX_TODO_QUERY_ITEMS,
    TODO_QUERY_OUTSIDE_QUESTION,
    todoChoiceFrom,
    todoMoveFrom,
    todoQueryFor,
    todoQueryQuestionId,
    todoQueryScores,
    type TodoQuery,
} from "../../../src/modules/reminders/todo-query";
import type { TodoItem, TodoStatus } from "../../../src/modules/todolist/parser";

/**
 * The TODO query: which items it asks about, and which answer counts as the work having moved there without
 * the list saying so. The item list reaches the model through the question criteria only.
 */

function item(id: string, status: TodoStatus, title = `Do the ${id} step`): TodoItem {
    return { id, title, status };
}

function bool(probability: number): ClassifierAnswer {
    return { type: "bool", probability };
}

function queryFor(items: TodoItem[]): TodoQuery {
    const query = todoQueryFor(items);
    if (query === undefined) {
        throw new Error("expected a query");
    }

    return query;
}

describe("todoQueryFor", () => {
    it("asks about the pending and blocked items, in list order", () => {
        const query = queryFor([
            item("done", "completed"),
            item("active", "in_progress"),
            item("next", "pending"),
            item("stuck", "blocked"),
        ]);

        expect(Object.keys(query.questions)).toEqual([
            todoQueryQuestionId("next"),
            todoQueryQuestionId("stuck"),
            TODO_QUERY_OUTSIDE_QUESTION,
        ]);
        expect(query.items.get(todoQueryQuestionId("next"))?.id).toBe("next");
        expect(query.items.get(todoQueryQuestionId("stuck"))?.status).toBe("blocked");
        expect(query.questions[TODO_QUERY_OUTSIDE_QUESTION]?.type).toBe("bool");
    });

    it("asks nothing when the list has no item the work could move to", () => {
        expect(todoQueryFor([])).toBeUndefined();
        expect(
            todoQueryFor([item("done", "completed"), item("active", "in_progress")]),
        ).toBeUndefined();
    });

    it("caps the candidates, keeping the first ones", () => {
        const items = Array.from({ length: MAX_TODO_QUERY_ITEMS + 2 }, (_value, index) =>
            item(`step-${index}`, "pending"),
        );
        const query = queryFor(items);

        expect(query.items.size).toBe(MAX_TODO_QUERY_ITEMS);
        expect(query.items.has(todoQueryQuestionId("step-4"))).toBe(false);
    });

    it("carries the title on one line and within the query's budget", () => {
        const multiline = queryFor([item("one", "pending", "Do\n  the\tthing")]);
        expect(multiline.questions[todoQueryQuestionId("one")]?.instructions).toContain(
            '"Do the thing"',
        );

        const long = "x".repeat(200);
        const clipped = queryFor([item("one", "pending", long)]);
        expect(clipped.questions[todoQueryQuestionId("one")]?.instructions).toContain(
            `"${"x".repeat(119)}…"`,
        );
        expect(clipped.questions[todoQueryQuestionId("one")]?.instructions).not.toContain(long);
    });
});

describe("todoMoveFrom", () => {
    const query = queryFor([item("next", "pending"), item("stuck", "blocked")]);
    const next = todoQueryQuestionId("next");
    const stuck = todoQueryQuestionId("stuck");
    const outside = TODO_QUERY_OUTSIDE_QUESTION;

    it("picks the strongest item above the threshold that beats the outside answer", () => {
        expect(
            todoMoveFrom({ [next]: bool(0.8), [stuck]: bool(0.5), [outside]: bool(0.3) }, query),
        ).toEqual({ item: item("next", "pending"), probability: 0.8 });
    });

    it("leaves the list alone when outside wins or ties", () => {
        expect(todoMoveFrom({ [next]: bool(0.6), [outside]: bool(0.7) }, query)).toBeUndefined();
        expect(todoMoveFrom({ [next]: bool(0.6), [outside]: bool(0.6) }, query)).toBeUndefined();
    });

    it("leaves the list alone below the threshold, and accepts exactly at it", () => {
        const justBelow = DEFAULT_TODO_MOVE_MIN_PROBABILITY - 0.01;
        expect(
            todoMoveFrom({ [next]: bool(justBelow), [outside]: bool(0.1) }, query),
        ).toBeUndefined();
        expect(
            todoMoveFrom(
                { [next]: bool(DEFAULT_TODO_MOVE_MIN_PROBABILITY), [outside]: bool(0.1) },
                query,
            ),
        ).toMatchObject({ item: { id: "next" } });
    });

    it("does not let a missing outside answer veto a clear move", () => {
        expect(todoMoveFrom({ [next]: bool(0.8) }, query)).toMatchObject({ item: { id: "next" } });
        expect(todoMoveFrom({}, query)).toBeUndefined();
        expect(
            todoMoveFrom(
                { [next]: bool(0.8), [outside]: { type: "score", score: 1, confidence: 1 } },
                query,
            ),
        ).toMatchObject({ item: { id: "next" } });
    });

    it("reports the scores per item and for the outside question", () => {
        expect(
            todoQueryScores({ [next]: bool(0.8), [stuck]: bool(0.4), [outside]: bool(0.3) }, query),
        ).toEqual({ next: 0.8, stuck: 0.4, outside: 0.3 });
    });
});

describe("todoChoiceFrom", () => {
    const query = queryFor([item("next", "pending"), item("stuck", "blocked")]);
    const moved = {
        [todoQueryQuestionId("next")]: bool(0.8),
        [todoQueryQuestionId("stuck")]: bool(0.3),
        [TODO_QUERY_OUTSIDE_QUESTION]: bool(0.2),
    };

    it("forces todo when a move outranks a deliberate none or an unreadable answer", () => {
        expect(todoChoiceFrom(query, moved, "none")).toMatchObject({
            choice: "todo",
            move: { id: "next", probability: 0.8 },
            scores: { next: 0.8, stuck: 0.3, outside: 0.2 },
        });
        expect(todoChoiceFrom(query, moved, undefined)).toMatchObject({ choice: "todo" });
    });

    it("lets an explicit pick win while still reporting the move", () => {
        expect(todoChoiceFrom(query, moved, "delegation")).toMatchObject({
            choice: "delegation",
            move: { id: "next", probability: 0.8 },
        });
    });

    it("keeps the choice and reports scores when nothing moved", () => {
        const verdict = todoChoiceFrom(query, { [TODO_QUERY_OUTSIDE_QUESTION]: bool(0.9) }, "none");

        expect(verdict).toMatchObject({ choice: "none", scores: { outside: 0.9 } });
        expect(verdict.move).toBeUndefined();
    });

    it("returns the choice untouched when there is no query or no answer", () => {
        expect(todoChoiceFrom(undefined, moved, "delegation")).toEqual({ choice: "delegation" });
        expect(todoChoiceFrom(query, undefined, "delegation")).toEqual({ choice: "delegation" });
    });
});
