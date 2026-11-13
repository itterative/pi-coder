/**
 * The embedding models this channel can run, one profile each.
 *
 * A profile is everything that is model-specific: the weights, the vector width, and the text formatting the model was
 * trained on. The runtime, the store, and the ranking are model-agnostic, so switching profiles is a config change —
 * and because `id` is part of the namespace and of every entry key, a switch builds a *new* index instead of mixing
 * widths, and switching back finds the old one intact.
 *
 * All three are GGUF from the publisher's own repository, so llm.cpp reads the tokenizer out of the weights and the
 * only per-model file is one download.
 */
export type ModelName = "gemma" | "qwen3" | "lfm2";

export interface ModelProfile {
    name: ModelName;
    /** Namespace component: changing it must change the index, and it does. */
    id: string;
    /** What `/outline status` and the consent dialog call it. */
    label: string;
    dims: number;
    /** Path inside the artifact directory. */
    file: string;
    url: string;
    sha256: string;
    bytes: number;
    /**
     * Prefix for a *query* only.
     *
     * All three models are asymmetric: Gemma and LFM2.5 take a plain task/role tag, Qwen3 takes an `Instruct:` block.
     * The prefix is never part of stored text or of an entry key, so changing it does not need a text-version bump —
     * but it must not leak into documents, which is why the two are separate fields here.
     */
    queryPrefix: string;
    /** Prefix for a *document*, when the model wants one. Qwen3 embeds documents bare. */
    docPrefix: string;
}

const HUGGING_FACE = "https://huggingface.co";

export const PROFILES: readonly ModelProfile[] = [
    {
        name: "qwen3",
        id: "qwen3-embedding-0.6b-q8",
        label: "Qwen3-Embedding-0.6B (Q8_0)",
        dims: 1024,
        file: "model/qwen3-embedding-0.6b-q8.gguf",
        url: `${HUGGING_FACE}/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf`,
        sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
        bytes: 639_150_592,
        queryPrefix:
            "Instruct: Given a code search query, retrieve the relevant source declarations\nQuery:",
        docPrefix: "",
    },
    {
        name: "gemma",
        id: "embeddinggemma-2-q8",
        label: "embeddinggemma-2 (Q8_0)",
        dims: 768,
        file: "model/embeddinggemma-2-q8.gguf",
        url: `${HUGGING_FACE}/ggml-org/embeddinggemma-2-GGUF/resolve/6ea3e3a309d12a4779cfda98b8c19800d2d5da71/embeddinggemma-2-Q8_0.gguf`,
        sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
        bytes: 309_855_456,
        queryPrefix: "task: code retrieval | query:",
        docPrefix: "",
    },
    {
        name: "lfm2",
        id: "lfm2.5-embedding-350m-q8",
        label: "LFM2.5-Embedding-350M (Q8_0)",
        dims: 1024,
        file: "model/lfm2.5-embedding-350m-q8.gguf",
        url: `${HUGGING_FACE}/LiquidAI/LFM2.5-Embedding-350M-GGUF/resolve/a80de9c5b941d429104f0038292a0ef5a860e486/LFM2.5-Embedding-350M-Q8_0.gguf`,
        sha256: "6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599",
        bytes: 379_216_640,
        queryPrefix: "query: ",
        docPrefix: "document: ",
    },
];

/**
 * The default profile.
 *
 * Qwen3 is the measured winner of the three on this channel's own query set (R@10 35/52 against 23 and 22), and its
 * build is minutes on a GPU. The other two stay selectable because they are cheaper and, on a CPU-only machine, faster.
 */
export const DEFAULT_MODEL: ModelName = "qwen3";

/**
 * The profile in force: `PI_CODER_OUTLINE_MODEL=gemma|qwen3|lfm2`, by name or by full id.
 *
 * A value that names nothing falls back to the default rather than failing: a typo must not take the lexical search
 * down with it, and the status line reports which profile is actually live.
 */
export function modelProfile(env: NodeJS.ProcessEnv = process.env): ModelProfile {
    const raw = (env.PI_CODER_OUTLINE_MODEL ?? "").trim().toLowerCase();

    if (raw.length === 0) {
        return PROFILES.find((profile) => profile.name === DEFAULT_MODEL) ?? PROFILES[0]!;
    }

    const match = PROFILES.find(
        (profile) => profile.name === raw || profile.id === raw || profile.id.startsWith(`${raw}-`),
    );

    return match ?? PROFILES.find((profile) => profile.name === DEFAULT_MODEL) ?? PROFILES[0]!;
}

/** The profile a name/id refers to, or `undefined` when the value names none of them. */
export function profileByName(value: string): ModelProfile | undefined {
    const raw = value.trim().toLowerCase();

    return PROFILES.find(
        (profile) => profile.name === raw || profile.id === raw || profile.id.startsWith(`${raw}-`),
    );
}
