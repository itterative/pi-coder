/**
 * Strip leading indentation from a template literal, based on the first line's indent.
 * Also removes leading/trailing blank lines.
 */
export function dedent(strings: TemplateStringsArray): string {
    const lines = strings[0].split("\n");

    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

    const indent = lines[0]?.match(/^(\s*)/)?.[1] ?? "";
    return lines.map((line) => line.slice(indent.length)).join("\n");
}
