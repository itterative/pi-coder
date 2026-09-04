import { describe, it, expect } from "vitest";
import { KNOWN_COMMANDS } from "../../../src/modules/sandbox/commands";
import type { CommandSpec, FlagSpec } from "../../../src/modules/sandbox/commands";

/**
 * Contract that keeps confined glob expansion sound against future registry edits.
 *
 * A pattern is expanded into many operands while the extractor's `writes` flag is still false, and
 * the post-extraction destination checks (`isSafeDestination`, `areHardLinksAllowed`, additional-root
 * containment) each examine a single positional path — the last one. That is safe only for as long as
 * every command treating a positional as a destination is already known as a writer or as an
 * additional-root mutator: both make the extractor reject a dynamic argument before any expansion is
 * attempted. A spec that later copies `rejectDirectoryDestination` onto a plain read command would
 * silently turn "one approved destination" into "one destination per match", and nothing in the
 * expansion code could see it. This test names that requirement instead of leaving it implicit.
 */

function collectSpecs(
    specs: Record<string, CommandSpec>,
    prefix: string[],
    into: [string, CommandSpec][],
): [string, CommandSpec][] {
    for (const [name, spec] of Object.entries(specs)) {
        const label = [...prefix, name].join(" ");
        into.push([label, spec]);
        if (spec.subcommands !== undefined) {
            collectSpecs(spec.subcommands, [name], into);
        }
    }

    return into;
}

function hasPositionalDestination(spec: CommandSpec): boolean {
    return Boolean(
        spec.rejectDirectoryDestination ||
        spec.rejectHardLinkedDestination ||
        spec.rejectHardLinkedPositionals ||
        spec.additionalRootLastPositional,
    );
}

/** True when the extractor rejects a dynamic operand for this spec before expanding it. */
function refusesDynamicOperands(spec: CommandSpec): boolean {
    if (spec.writes === true || spec.additionalRootOnly === true) {
        return true;
    }

    return Object.values(spec.flags ?? {}).some((flag) => flag.requiresAdditionalRoot === true);
}

/**
 * A flag that writes must write to *its own value*, otherwise the destination is a positional and the
 * spec must say so through a destination marker (see `positionalsAreDestinations` in
 * `heuristics/command-access.ts`, which is what keeps a glob out of a destination slot). `sed -i` is
 * the shape this exists for: the flag carries no path value, the files edited in place are positionals,
 * and only `rejectHardLinkedPositionals` makes the spec read as "positionals are destinations".
 */
function declaresItsDestinationSlot(spec: CommandSpec, flag: FlagSpec): boolean {
    if (flag.pathSlots !== undefined) {
        return true;
    }

    return (
        spec.writes === true ||
        spec.rejectDirectoryDestination === true ||
        spec.rejectHardLinkedDestination === true ||
        spec.rejectHardLinkedPositionals === true ||
        spec.additionalRootLastPositional === true
    );
}

const labeledSpecs = collectSpecs(KNOWN_COMMANDS, [], []);
const destinationSpecs = labeledSpecs.filter(([, spec]) => hasPositionalDestination(spec));
const writeFlagSpecs = labeledSpecs
    .map(([label, spec]) => {
        const flags = Object.entries(spec.flags ?? {}).filter(([, flag]) => flag.writes === true);

        return [label, spec, flags] as const;
    })
    .filter(([, , flags]) => flags.length > 0);

describe("command registry: positional destinations", () => {
    it("finds the destination specs worth guarding", () => {
        // A vacuous filter would make the contract below pass for the wrong reason, so name the two
        // members that must always be present: `cp` (last positional is a destination) and `sed`
        // (in-place editing reaches it through a flag instead of spec-level writes).
        expect(destinationSpecs.length).toBeGreaterThan(0);

        const labels = new Set(destinationSpecs.map(([label]) => label));
        expect(labels.has("cp")).toBe(true);
        expect(labels.has("sed")).toBe(true);
    });

    it("finds the write-flag specs worth guarding", () => {
        // Measured set, deliberately exact: adding a command with a writing flag makes this fail so
        // the destination-declaration contract below is looked at rather than inherited silently.
        expect(new Set(writeFlagSpecs.map(([label]) => label.split(" ")[0]))).toEqual(
            new Set(["base64", "tree", "sort", "sed"]),
        );
    });

    it.each(writeFlagSpecs.map(([label, spec, flags]) => [label, spec, flags] as const))(
        "%s declares where its write destination lives",
        (_label, spec, flags) => {
            for (const [name, flag] of flags) {
                expect(
                    declaresItsDestinationSlot(spec, flag),
                    `${_label} ${name} writes without a destination marker`,
                ).toBe(true);
            }
        },
    );

    it.each(destinationSpecs.map(([label, spec]) => [label, spec] as const))(
        "%s refuses dynamic operands",
        (_label, spec) => {
            expect(refusesDynamicOperands(spec)).toBe(true);
        },
    );
});
