import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runSearch } from "../../../src/tools/code/search";
import { runShow } from "../../../src/tools/code/show";
import { CallTiming } from "../../../src/tools/code/timing";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const FILES: Record<string, string> = {
    "src/net/socket.h": `#pragma once

namespace net {

/** A socket handle. */
class Socket : public Handle {
public:
    explicit Socket(int fd);
    ~Socket();

    /** Connect to an address. */
    bool connect(const Address& addr) const;
    bool connect(const Endpoint& ep) const;

    int fd() const;

private:
    int fd_;
};

struct Point {
    float x, y;
};

}  // namespace net
`,
    "src/net/socket.cpp": `#include "socket.h"

namespace net {

Socket::Socket(int fd) : fd_(fd) {}

Socket::~Socket() = default;

bool Socket::connect(const Address& addr) const {
    return addr.valid() && fd_ >= 0;
}

bool Socket::connect(const Endpoint& ep) const {
    return ep.valid();
}

int Socket::fd() const { return fd_; }

}  // namespace net
`,
    "src/net/client.cpp": `#include "socket.h"

namespace net {

void Client::run() {
    socket_.connect(addr);
    socket_.connect(ep);
    socket_.connect(addr);
}

}
`,
    "src/hip/saxpy.hip": `#include <hip/hip_runtime.h>

__global__ void saxpy(int n, float a, const float* x, float* y) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) y[i] = a * x[i] + y[i];
}

__device__ float twice(float v) { return 2.0f * v; }

int main() {
    float *x, *y;
    saxpy<<<blocks, threads>>>(n, 2.0f, x, y);
    hipLaunchKernelGGL(saxpy, dim3(blocks), dim3(threads), 0, 0, n, 2.0f, x, y);
}
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline digest", () => {
    it("maps a module with public members and definition tags", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/net",
        });

        expect(result.text).toContain("# digest src/net · 3 files · cpp ·");
        expect(result.text).toContain("src/net/socket.h [tiny]");
        expect(result.text).toContain("class Socket : public Handle");
        expect(result.text).toContain("connect(const Address& addr) const");
        expect(result.text).toContain("Socket::connect(const Address& addr) const  :9-11 [def]");
        expect(result.text).toContain("float x");
        expect(result.text).not.toContain("int fd_  :18");
        expect(result.parseErrors).toBe(0);
    });

    it("lists files when a flat directory exceeds the character limit", async () => {
        const flat = new MemoryCodeSource("/project", {
            "src/a.cpp": "void a();\n",
            "src/b.cpp": "void b();\n",
            "src/c.cpp": "void c();\n",
        });
        const result = await runDigest(flat, {
            action: "digest",
            path: "src",
            limit: 20,
        });

        expect(result.text).toContain("declarations exceed the 20-char limit");
        expect(result.text).toContain("a.cpp");
        expect(result.text).toContain("b.cpp");
        expect(result.text).not.toContain("# next:");
        expect(result.truncated).toBe(true);
    });

    it("collapses a huge file to its top-level declarations", async () => {
        const methods = Array.from(
            { length: 1_600 },
            (_, index) => `  void method_${index}();`,
        ).join("\n");
        const huge = new MemoryCodeSource("/project", {
            "src/huge.h": `class Huge {\npublic:\n${methods}\n};\n`,
        });
        const result = await runDigest(huge, {
            action: "digest",
            path: "src/huge.h",
        });

        expect(result.text).toContain("class Huge");
        expect(result.text).toContain("huge file: member detail omitted");
        expect(result.text).not.toContain("method_1599");
    });

    it("includes private and field detail when asked", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src/net/socket.h",
            detail: "full",
        });

        expect(result.text).toContain("fd_");
    });

    it("degrades to a directory map when the character limit is too small", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: ".",
            limit: 200,
        });

        expect(result.text).toContain("declarations exceed the");
        expect(result.text).toContain("src/");
        expect(result.truncated).toBe(true);
    });
});

describe("outline show", () => {
    it("pairs a header declaration with its source definition", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "Socket::connect",
        });

        expect(result.text).toContain("src/net/socket.h");
        expect(result.text).toContain("method net::Socket::connect · declaration");
        expect(result.text).toContain("src/net/socket.cpp");
        expect(result.text).toContain("method net::Socket::connect · definition");
        expect(result.text).toContain("return addr.valid()");
        expect(result.text).toContain("# note: 2 overloads match");
        expect(result.text).toContain("net::Socket::connect(const Address&)");
        expect(result.matches).toBeGreaterThan(0);
    });

    it("selects one overload by parameter types", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "Socket::connect(const Endpoint&)",
        });

        expect(result.text).toContain("const Endpoint&");
        expect(result.text).not.toContain("return addr.valid()");
        expect(result.text).not.toContain("# note:");
    });

    it("splits a comma-joined symbol list into separate selectors", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "Socket::fd, Socket::connect(const Endpoint&)",
        });

        expect(result.text).toContain("int fd() const");
        expect(result.text).toContain("const Endpoint&");
        expect(result.text).not.toContain("return addr.valid()");
    });

    it("keeps class signatures public by default", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "Socket",
        });

        expect(result.text).toContain("class net::Socket");
        expect(result.text).toContain("connect(const Address& addr) const");
        expect(result.text).not.toContain("int fd_  :18");
    });

    it("returns the full class body when asked", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "Socket",
            detail: "full",
        });

        expect(result.text).toContain("private:");
        expect(result.text).toContain("fd_");
    });

    it("uses the definition when a forward declaration and definition share a name", async () => {
        const forward = new MemoryCodeSource("/project", {
            "src/forward.h": `class Forward;
class Forward {
public:
    void go();
};
`,
        });
        const result = await runShow(forward, {
            action: "show",
            path: "src",
            query: "Forward",
        });

        expect(result.text).toContain("class Forward");
        expect(result.text).toContain("go()");
        expect(result.text).not.toContain("no public members");
    });

    it("lists same-signature definitions from different files as ambiguous", async () => {
        const duplicate = new MemoryCodeSource("/project", {
            "src/a.cpp": "int main() { return 1; }\n",
            "src/b.cpp": "int main() { return 2; }\n",
        });
        const result = await runShow(duplicate, {
            action: "show",
            path: "src",
            query: "main",
        });

        expect(result.text).toContain("# ambiguous: 2 matches for main");
        expect(result.text).toContain("src/a.cpp:1");
        expect(result.text).toContain("src/b.cpp:1");
        expect(result.text).not.toContain("return 1");
        expect(result.matches).toBe(2);
    });

    it("dedents a member's docs and body together", async () => {
        const indented = new MemoryCodeSource("/project", {
            "src/indent.hpp": `namespace n {
class Outer {
public:
  /// first line
  /// second line
  void method() {
    int value = 1;
  }
};
}
`,
        });
        const result = await runShow(indented, {
            action: "show",
            path: "src/indent.hpp",
            query: "Outer::method",
        });

        expect(result.text).toContain("\n/// first line\n/// second line\nvoid method() {");
        expect(result.text).toContain("\n  int value = 1;");
        expect(result.text).not.toContain("  /// second line");
    });

    it("keeps long signatures intact in show signatures mode", async () => {
        const params = Array.from(
            { length: 20 },
            (_, index) => `const std::string& argument_${index}`,
        ).join(", ");
        const long = new MemoryCodeSource("/project", {
            "src/long.h": `void very_long(${params});\n`,
        });
        const result = await runShow(long, {
            action: "show",
            path: "src/long.h",
            query: "very_long",
            detail: "signatures",
        });

        expect(result.text).toContain("argument_19");
        expect(result.text).not.toContain("…");
    });

    it("returns only declarations in signatures mode", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "Socket::connect",
            detail: "signatures",
        });

        expect(result.text).toContain("declaration");
        expect(result.text).not.toContain("return addr.valid()");
        expect(result.text).not.toContain("definition");
    });

    it("reports a missing symbol without throwing", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "NoSuchSymbol",
        });

        expect(result.text).toContain("# not found");
        expect(result.matches).toBe(0);
    });

    it("resolves destructor and conversion-operator names", async () => {
        const destructor = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "Socket::~Socket",
        });
        const conversion = await runShow(source(), {
            action: "show",
            path: "src/net",
            query: "Socket::operator bool",
        });

        expect(destructor.text).toContain("~Socket");
        expect(destructor.text).not.toContain("# no definition found");
        expect(conversion.text).toContain("operator bool");
    });

    it("keeps HIP qualifiers in the extracted source", async () => {
        const result = await runShow(source(), {
            action: "show",
            path: "src/hip",
            query: "saxpy",
        });

        expect(result.text).toContain("__global__ void saxpy");
        expect(result.text).toContain("blockIdx.x");
    });
});

describe("outline search", () => {
    const SEARCH_FILES: Record<string, string> = {
        "src/engine/call_list.hpp": `#pragma once
namespace engine {
class CallList {
public:
    void execute();
    void execute_again();
};
}
`,
        "src/engine/plan.cpp": `namespace engine {
class Plan {
public:
    void run();
};
void make_plan() {}
void make_plan_cache() {}
void play() {}
}
`,
        "src/net/socket.h": `namespace net {
class Socket {
public:
    bool connect();
};
}
`,
    };

    function searchSource(): MemoryCodeSource {
        return new MemoryCodeSource("/project", SEARCH_FILES);
    }

    it("finds declarations by case-insensitive name substring", async () => {
        const result = await runSearch(searchSource(), {
            action: "search",
            path: "src",
            query: "PLAN",
        });

        expect(result.text).toContain('# search "PLAN"');
        expect(result.text).toContain("class  engine::Plan");
        expect(result.text).toContain("src/engine/plan.cpp:2-5");
        expect(result.text).toContain("make_plan");
        expect(result.text).not.toContain("play");
        expect(result.matches).toBe(3);
    });

    it("matches a qualified query against the qualified name", async () => {
        const result = await runSearch(searchSource(), {
            action: "search",
            path: "src",
            query: "CallList::execute",
        });

        expect(result.text).toContain("engine::CallList::execute");
        expect(result.text).toContain("void execute()");
    });

    it("falls back to token and transposition distance when there are no literal hits", async () => {
        const result = await runSearch(searchSource(), {
            action: "search",
            path: "src",
            query: "make_plna",
        });

        expect(result.text).toContain("no name or doc matches");
        expect(result.text).toContain("engine::make_plan");
        expect(result.text).toContain("~1");
        expect(result.text).not.toContain("make_plan_cache");
    });

    it("keeps the qualifier while fuzzy-matching the last component", async () => {
        const result = await runSearch(searchSource(), {
            action: "search",
            path: "src",
            query: "CallList::exectue",
        });

        expect(result.text).toContain("engine::CallList::execute");
        expect(result.text).toContain("~1");
    });

    it("returns all matching declarations when the output fits", async () => {
        const result = await runSearch(searchSource(), {
            action: "search",
            path: "src",
            query: "plan",
        });

        expect(result.text).toContain("engine::Plan");
        expect(result.text).toContain("make_plan");
        expect(result.matches).toBe(3);
        expect(result.truncated).toBe(false);
    });

    it("requires a query and reports an empty result", async () => {
        const empty = await runSearch(searchSource(), {
            action: "search",
            path: "src",
            query: " ",
        });
        const missing = await runSearch(searchSource(), {
            action: "search",
            path: "src",
            query: "zzzz",
        });

        expect(empty.text).toContain("# search needs a query");
        expect(missing.text).toContain("# no declarations or approximate matches");
        expect(missing.matches).toBe(0);
    });
});

describe("outline usages", () => {
    it("reports declarations, calls, and the syntactic mode", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src/net",
            query: "Socket::connect",
        });

        expect(result.text).toContain("syntactic (name-based)");
        expect(result.text).toContain("[decl]");
        expect(result.text).toContain("[def]");
        expect(result.text).toContain("[call]");
        expect(result.text).toContain("socket_.connect(addr)");
    });

    it("splits a comma-joined symbol list", async () => {
        const joined = await runUsages(source(), {
            action: "usages",
            path: "src/net",
            query: "Socket::connect, Socket::fd",
            kind: "call",
        });
        const separate = await runUsages(source(), {
            action: "usages",
            path: "src/net",
            query: ["Socket::connect", "Socket::fd"].join(", "),
            kind: "call",
        });

        expect(joined.text).toBe(separate.text);
        expect(joined.matches).toBe(separate.matches);
    });

    it("filters to calls", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src/net",
            query: "connect",
            kind: "call",
        });

        expect(result.text).toContain("[call]");
        expect(result.text).not.toContain("[def]");
        expect(result.text).not.toContain("[decl]");
    });

    it("returns all usages when the output fits", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src/net",
            query: "connect",
        });

        expect(result.matches).toBeGreaterThan(1);
        expect(result.text).toContain("[call]");
        expect(result.text).not.toContain("# omitted");
        expect(result.truncated).toBe(false);
    });

    it("tags HIP kernel launches separately", async () => {
        const result = await runUsages(source(), {
            action: "usages",
            path: "src/hip",
            query: "saxpy",
        });

        expect(result.text).toContain("[def]");
        expect(result.text).toContain("[launch]");
        expect(result.text).toContain("hipLaunchKernelGGL");
    });
});

describe("outline timing", () => {
    it("counts fresh parses, then reports the same files as cached", async () => {
        const cold = new CallTiming();
        await runSearch(
            source(),
            { action: "search", query: "connect" },
            undefined,
            undefined,
            cold,
        );
        const first = cold.snapshot();

        expect(first.files).toBeGreaterThan(0);
        expect(first.parsed).toBe(first.files);
        expect(first.cached).toBe(0);
        expect(first.totalMs).toBeGreaterThan(0);

        const warm = new CallTiming();
        await runSearch(
            source(),
            { action: "search", query: "connect" },
            undefined,
            undefined,
            warm,
        );
        const second = warm.snapshot();

        expect(second.files).toBe(first.files);
        expect(second.parsed).toBe(0);
        expect(second.cached).toBe(second.files);
    });
});
