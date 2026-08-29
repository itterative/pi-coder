import { describe, it, expect } from "vitest";
import { suggestRule } from "../../../src/modules/sandbox/suggestions";

const t = (s: string): string[] => s.split(" ");

describe("suggestRule: curated table", () => {
    describe("scoped rows (rule remembers the command identity)", () => {
        it.each([
            [[...t("npx vitest run")], "npx vitest *"],
            [[...t("npx tsx script.ts")], "npx tsx script.ts"],
            [[...t("npx tsx script.ts --help")], "npx tsx script.ts *"],
            [[...t("npx eslint")], "npx eslint"],
            [[...t("npm run build")], "npm run build"],
            [[...t("npm run test -- --watch")], "npm run test *"],
            [[...t("yarn test")], "yarn test"],
            [[...t("yarn install")], "yarn install"],
            [[...t("pnpm install")], "pnpm install"],
            [[...t("bun test")], "bun test"],
            [[...t("uv run pytest")], "uv run pytest"],
            [[...t("uvx ruff")], "uvx ruff"],
            [[...t("docker ps -a")], "docker ps *"],
            [[...t("docker build .")], "docker build *"],
            [[...t("cargo test --release")], "cargo test *"],
            [[...t("poetry run pytest")], "poetry run pytest"],
        ])("suggests %s", (tokens, expected) => {
            expect(suggestRule(tokens)).toBe(expected);
        });
    });

    describe("docker compose specificity", () => {
        it("compose subcommand scopes to the compose action", () => {
            expect(suggestRule(t("docker compose up -d"))).toBe("docker compose up *");
        });

        it("non-compose docker uses the docker row", () => {
            expect(suggestRule(t("docker exec app sh"))).toBe("docker exec *");
        });

        it("unsafe compose action falls through to the docker row", () => {
            expect(suggestRule(["docker", "compose", "$(evil)"])).toBe("docker compose *");
        });
    });

    describe("fixed rows (no scoping — first token is data or flags)", () => {
        it.each([
            [[...t("make")], "make"],
            [[...t("make build")], "make *"],
            [[...t("make -j8 all")], "make *"],
            [[...t("tox -e py312")], "tox *"],
            [[...t("ruff check .")], "ruff *"],
            [[...t("pytest tests -x")], "pytest *"],
        ])("suggests %s", (tokens, expected) => {
            expect(suggestRule(tokens)).toBe(expected);
        });
    });

    describe("unsafe tokens", () => {
        it("command substitution in the scoped token: no suggestion", () => {
            expect(suggestRule(["npx", "$(evil)"])).toBeNull();
        });

        it("glob in the scoped token: no suggestion", () => {
            expect(suggestRule(["npx", "*.js"])).toBeNull();
        });

        it("dollar-sign token: no suggestion", () => {
            expect(suggestRule(["docker", "$x"])).toBeNull();
        });

        it("single-token runner (nothing to scope on): no suggestion", () => {
            expect(suggestRule(["npx"])).toBeNull();
        });

        it.each([
            ["npx -c echo hello"],
            ["npx --call echo hello"],
            ["npx tsx -e console.log(1)"],
            ["npx tsx --eval console.log(1)"],
            ["npx node -p console.log(1)"],
            ["npx node --print console.log(1)"],
            ["npx --call=echo hello"],
        ])("inline script is not remembered: %s", (command) => {
            expect(suggestRule(t(command))).toBeNull();
        });

        it("dots and slashes are safe (paths, script names)", () => {
            expect(suggestRule(t("cargo run --manifest-path sub/x.json"))).toBe("cargo run *");
        });

        it("hyphens and colons are safe (script names)", () => {
            expect(suggestRule(t("npm run test:unit"))).toBe("npm run test:unit");
            expect(suggestRule(t("npm run test:unit -- --watch"))).toBe("npm run test:unit *");
        });

        it("scoped packages are safe (@scope/pkg)", () => {
            expect(suggestRule(t("npx @typescript-eslint/eslint"))).toBe("npx @typescript-eslint/eslint");
        });
    });

    describe("no matching row", () => {
        it.each([
            [[...t("nc host 80")], null],
            [[...t("curl -s url")], null],
            [[...t("rm -rf build")], null],
            [[...t("bash -c x")], null],
            [[...t("python x.py")], null],
            [[...t("pip install requests")], null],
        ])("no row for %s", (tokens, expected) => {
            expect(suggestRule(tokens)).toBe(expected);
        });

        it("empty segment", () => {
            expect(suggestRule([])).toBeNull();
        });
    });
});
