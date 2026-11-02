import type { ImageStore, SandboxImageRecord } from "./image";

/**
 * Housekeeping for the images a recipe builds.
 *
 * Every rebuild of a changed recipe adds a tag, and nothing ever removed the old ones: a checkout that
 * iterates on its Containerfile accumulates a full image per iteration. Retention is deliberately boring —
 * keep a few newest, never touch an image a container references, and never let housekeeping fail a build.
 */

/**
 * Recipe images kept after a build.
 *
 * Three, not one: the tag is content-addressed, so going back to a previous recipe is a *tag that still
 * exists*, and a stale session's container keeps running on the image it started with. One slot for the
 * image just built, one for a rollback, one for a session that outlived the rebuild.
 */
export const KEEP_SANDBOX_IMAGES = 3;

export interface RetentionRequest {
    images: readonly SandboxImageRecord[];
    /** Image IDs any container references, running or stopped. */
    inUse: readonly string[];
    /** How many images to keep, counting the ones that cannot be removed. */
    keep: number;
    /**
     * References that are never removed even when old, normally the tag just built.
     *
     * Timestamps come from podman text and are only as trustworthy as their parse, so the one image the pass
     * must not touch is protected by name rather than by being newest.
     */
    protect?: readonly string[];
}

export interface RetentionPlan {
    /** Newest first. */
    keep: readonly SandboxImageRecord[];
    /** Oldest first, i.e. removal order. */
    remove: readonly SandboxImageRecord[];
}

/**
 * Decide which sandbox images to keep, from podman's own answers.
 *
 * In-use images are kept regardless of age and **consume a slot**: "keep three" is a budget for the whole
 * set, so a container pinning an old image does not silently grow it to four. Equal timestamps (a scripted
 * double build) fall back to the ID so the choice is stable across runs rather than dependent on listing
 * order.
 */
export function planRetention(request: RetentionRequest): RetentionPlan {
    const inUse = new Set(request.inUse.map(normalizeImageId));
    const protectedReferences = new Set(request.protect ?? []);
    const ordered = request.images.toSorted((left, right) => compareNewestFirst(left, right));
    const keep: SandboxImageRecord[] = [];
    const remove: SandboxImageRecord[] = [];

    for (const image of ordered) {
        const pinned =
            protectedReferences.has(image.reference) || inUse.has(normalizeImageId(image.id));

        if (pinned || keep.length < request.keep) {
            keep.push(image);

            continue;
        }

        remove.push(image);
    }

    return { keep, remove: remove.toReversed() };
}

export interface PruneSandboxImagesOptions {
    store: ImageStore;
    /** Defaults to {@link KEEP_SANDBOX_IMAGES}. */
    keep?: number;
    /** References to keep regardless of age; pass the tag that was just built. */
    protect?: readonly string[];
}

export interface PruneSandboxImagesResult {
    /** References removed, for the message a human reads. */
    removed: readonly string[];
    /** Set when the pass itself failed; the image the caller built is fine either way. */
    error?: string;
}

/**
 * Run one retention pass.
 *
 * Failures are returned, not thrown. The caller has just produced a working image, and a housekeeping pass
 * that cannot list or remove is not a reason to report the build as failed — it is a reason to mention it
 * once and move on.
 */
export async function pruneSandboxImages(
    options: PruneSandboxImagesOptions,
): Promise<PruneSandboxImagesResult> {
    const keep = options.keep ?? KEEP_SANDBOX_IMAGES;

    try {
        const images = await options.store.listSandboxImages();

        if (images.length <= keep) {
            return { removed: [] };
        }

        const inUse = await options.store.containersInUse();
        const plan = planRetention({ images, inUse, keep, protect: options.protect });

        if (plan.remove.length === 0) {
            return { removed: [] };
        }

        await options.store.removeImages(plan.remove.map((image) => image.id));

        return { removed: plan.remove.map((image) => image.reference) };
    } catch (error) {
        return { removed: [], error: describe(error) };
    }
}

function compareNewestFirst(left: SandboxImageRecord, right: SandboxImageRecord): number {
    const leftTime = parseCreated(left.created);
    const rightTime = parseCreated(right.created);

    if (leftTime === undefined || rightTime === undefined) {
        // An unparseable timestamp must not decide a removal; fall through to the stable tie-break.
        return left.id.localeCompare(right.id);
    }

    if (leftTime !== rightTime) {
        return rightTime - leftTime;
    }

    return left.id.localeCompare(right.id);
}

/**
 * Order by podman's creation stamp.
 *
 * `podman image inspect` prints Go's `time.Time` string ("2025-02-09 12:34:56.123456789 +0000 UTC"), which
 * `Date.parse` rejects because of the trailing zone name. The wall clock is all ordering needs: every image in
 * one host's storage is stamped by the same clock, and the zone offset only reorders images built under a
 * changed `TZ`. An unparseable stamp returns `undefined` and the caller falls back to the ID tie-break.
 */
function parseCreated(value: string): number | undefined {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);

    if (match === null) {
        return undefined;
    }

    const parsed = Date.parse(`${match[1]}T${match[2]}Z`);

    return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Compare image IDs the way podman prints them in different places: full 64-hex from `inspect`, a short
 * prefix from a table listing, and sometimes with a `sha256:` scheme in front.
 */
export function normalizeImageId(id: string): string {
    const withoutScheme = id.startsWith("sha256:") ? id.slice("sha256:".length) : id;

    return withoutScheme.trim().toLowerCase().slice(0, 12);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
