import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { select } from "../../../tui/select";

/**
 * The one question the container backend asks, and the only place it is asked.
 *
 * It exists because "no image" is a normal state, not an error: the recipe is in the checkout, the tag is a
 * content hash, so an unbuilt image simply means nobody has run the build on this machine yet. Asking turns
 * that into a decision the user can make once, instead of an environment variable they have to know about.
 *
 * The two answers are deliberately asymmetric. Building enables the container for this project and is
 * remembered (`sandbox.backend = "container"`); keeping bubblewrap is remembered too (`"bwrap"`), so the
 * question is not a recurring interruption. Dismissing the dialog records only the declined recipe tag, which
 * means it comes back when the recipe changes and needs a rebuild — the one case where asking again is right.
 */
export type SandboxImageAnswer = "build" | "bwrap" | "later";

export interface SandboxImageQuestion {
    /** The image tag the recipe hashes to, e.g. `localhost/pi-coder-sandbox:2c647c8…`. */
    image: string;
    /** The Containerfile, named only when the user has to decide whether to trust it. */
    recipePath: string;
}

/** Whether this runtime can show a dialog at all; `pi -p`, CI, and child runtimes cannot. */
export function canPromptForSandboxImage(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
    return ctx.hasUI && ctx.mode === "tui";
}

export async function askAboutSandboxImage(
    question: SandboxImageQuestion,
    ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">,
): Promise<SandboxImageAnswer> {
    const answer = await select<SandboxImageAnswer>(
        {
            title: "Sandbox container",
            headerContent: (container, theme) => {
                container.addChild(
                    new Text(
                        theme.fg(
                            "muted",
                            `  ${question.recipePath} has not been built for its current contents.`,
                        ),
                        1,
                        0,
                    ),
                );
                container.addChild(
                    new Text(
                        theme.fg(
                            "muted",
                            "  The recipe runs on this machine once; after that every command runs",
                        ),
                        1,
                        0,
                    ),
                );
                container.addChild(
                    new Text(
                        theme.fg("muted", "  inside the container instead of bubblewrap."),
                        1,
                        0,
                    ),
                );
            },
            items: [
                { value: "build", label: "Build the image now, then use the container" },
                { value: "bwrap", label: "Keep using bubblewrap (remembered for this project)" },
            ],
        },
        ctx,
    );

    // Dismissed: remember only this recipe state, so a later rebuild still asks.
    return answer ?? "later";
}
