import { randomInt } from "node:crypto";

export const SLUG_ADJECTIVES = [
    "amber",
    "ancient",
    "bright",
    "calm",
    "cobalt",
    "copper",
    "crimson",
    "distant",
    "gentle",
    "golden",
    "hidden",
    "hushed",
    "indigo",
    "kind",
    "lucid",
    "misty",
    "quiet",
    "rapid",
    "restful",
    "silver",
    "soft",
    "steady",
    "sunlit",
    "swift",
    "violet",
    "warm",
    "wandering",
    "white",
    "wild",
    "zealous",
] as const;

export const SLUG_NOUNS = [
    "anchor",
    "brook",
    "canyon",
    "comet",
    "falcon",
    "garden",
    "harbor",
    "island",
    "lantern",
    "meadow",
    "orbit",
    "pine",
    "quartz",
    "raven",
    "river",
    "summit",
    "thicket",
    "trail",
    "valley",
    "willow",
    "beacon",
    "cliff",
    "grove",
    "horizon",
    "kestrel",
    "maple",
    "northstar",
    "pebble",
    "rainfall",
    "shore",
    "stone",
    "tide",
] as const;

/** Creates a memorable random slug suitable for a workspace directory name. */
export function randomSlug(
    adjectives: readonly string[] = SLUG_ADJECTIVES,
    nouns: readonly string[] = SLUG_NOUNS,
): string {
    const adjectivePool = adjectives.length ? adjectives : ["quiet"];
    const nounPool = nouns.length ? nouns : ["workspace"];
    const adjective = adjectivePool[randomInt(adjectivePool.length)] ?? "quiet";
    const noun = nounPool[randomInt(nounPool.length)] ?? "workspace";
    const suffix = randomInt(36 ** 3)
        .toString(36)
        .padStart(3, "0");
    return `${adjective.trim()}-${noun}-${suffix}`;
}
