import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const { createJiti } = require(workerData.jitiPath);
const jiti = createJiti(import.meta.url);
const code = await jiti.import(workerData.codeModulePath);
let usages;

if (parentPort === null) {
    throw new Error("outline parse worker started without a parent port");
}

parentPort.on("message", async (message) => {
    try {
        let result;

        switch (message.kind) {
            case "parse":
                result = {
                    kind: "parse",
                    value: await code.parseCodeFile(message.source, message.path, message.language),
                };

                break;
            case "usageIndex":
                usages ??= await jiti.import(workerData.usageModulePath);
                result = {
                    kind: "usageIndex",
                    value: await usages.buildUsageIndex(message.file),
                };

                break;
            default:
                throw new Error(
                    `outline parse worker received an unknown request: ${message.kind}`,
                );
        }

        parentPort.postMessage({ id: message.id, ok: true, result });
    } catch (error) {
        parentPort.postMessage({
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
