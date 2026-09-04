import {
    ModelRuntime,
    type ExtensionContext,
    type SessionManager,
} from "@earendil-works/pi-coding-agent";

function mergeProviderHeaders(
    configured: Record<string, string> | undefined,
    resolved: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
    const merged = { ...configured };
    for (const [name, value] of Object.entries(resolved ?? {})) {
        if (value === null) delete merged[name];
        else merged[name] = value;
    }
    return Object.keys(merged).length ? merged : undefined;
}

export function shouldCopyParentApiKey(options: {
    childHasAuth: boolean;
    parentHasApiKey: boolean;
    parentUsesOAuth: boolean;
}): boolean {
    return !options.childHasAuth && options.parentHasApiKey && !options.parentUsesOAuth;
}

export async function createChildModelRuntime(
    ctx: ExtensionContext,
    model: NonNullable<ExtensionContext["model"]>,
): Promise<ModelRuntime> {
    const parentAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!parentAuth.ok) throw new Error(parentAuth.error);

    const runtime = await ModelRuntime.create();
    const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
    if (nativeProvider) runtime.registerNativeProvider(nativeProvider);

    const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
    if (providerConfig) {
        runtime.registerProvider(model.provider, {
            ...providerConfig,
            baseUrl: parentAuth.baseUrl ?? providerConfig.baseUrl,
            headers: mergeProviderHeaders(providerConfig.headers, parentAuth.headers),
        });
    }

    let runtimeModel = runtime.getModel(model.provider, model.id) ?? model;
    let childAuth = await runtime.getAuth(runtimeModel);
    const childHasAuth = Boolean(childAuth?.auth.apiKey || childAuth?.auth.headers);
    const parentUsesOAuth = ctx.modelRegistry.isUsingOAuth(model);

    if (
        shouldCopyParentApiKey({
            childHasAuth,
            parentHasApiKey: Boolean(parentAuth.apiKey),
            parentUsesOAuth,
        })
    ) {
        await runtime.setRuntimeApiKey(model.provider, parentAuth.apiKey!);
        runtimeModel = runtime.getModel(model.provider, model.id) ?? model;
        childAuth = await runtime.getAuth(runtimeModel);
    }

    if (!childAuth?.auth.apiKey && !childAuth?.auth.headers) {
        const authKind = parentUsesOAuth ? "OAuth credentials" : "provider credentials";
        throw new Error(
            `Could not synchronize ${authKind} for child model ${model.provider}/${model.id}.`,
        );
    }
    return runtime;
}

/** What a persisted transcript recorded about how it was being run. */
export interface ChildRestoredModel {
    /** Stored as `provider/model`; absent when the transcript predates model recording. */
    modelSpec: string | undefined;
    thinkingLevel: ReturnType<SessionManager["buildSessionContext"]>["thinkingLevel"];
}

/**
 * Read the model and thinking level a child transcript was actually built with.
 *
 * Only a resumed child has anything to restore, and the stored context is the only trustworthy
 * source: a definition may have selected another model, or the parent may have switched, while the
 * stored messages were produced by the model named here. Resolving through that recorded value is
 * what keeps a continuation consistent with its own history.
 */
export function restoreChildSessionModel(
    sessionManager: SessionManager,
    childSessionFile: string | undefined,
): ChildRestoredModel | undefined {
    if (!childSessionFile) {
        return undefined;
    }

    const context = sessionManager.buildSessionContext();
    return {
        modelSpec: context?.model
            ? `${context.model.provider}/${context.model.modelId}`
            : undefined,
        thinkingLevel: context?.thinkingLevel,
    };
}

export function resolveChildModel(
    ctx: ExtensionContext,
    modelSpec: string | undefined,
): NonNullable<ExtensionContext["model"]> {
    if (!ctx.model) throw new Error("No parent model is selected.");
    if (!modelSpec) return ctx.model;

    const slash = modelSpec.indexOf("/");
    if (slash > 0) {
        const model = ctx.modelRegistry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1));
        if (model) return model;
    } else {
        const sameProvider = ctx.modelRegistry.find(ctx.model.provider, modelSpec);
        if (sameProvider) return sameProvider;
        const matches = ctx.modelRegistry.getAll().filter((model) => model.id === modelSpec);
        if (matches.length === 1) return matches[0]!;
    }
    throw new Error(`Agent model is unavailable or ambiguous: ${modelSpec}`);
}
