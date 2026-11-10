import { describe, expect, it } from "vitest";

import { parseCppFile } from "../../../src/tools/code/cpp";

const CPP = `namespace net {
template <typename T>
class Socket : public Handle {
public:
  explicit Socket(int fd);
  ~Socket();
  bool connect(const Address& addr) const;
  operator bool() const;
  static int count();
private:
  int fd_;
  T value_;
};
bool Socket::connect(const Address& addr) const { return true; }
}
using Alias = Socket<int>;
typedef int MyInt;
enum class Color : uint8_t { Red, Green };
struct Point { float x, y; };
namespace a::b { void f(); }
extern "C" { void cfunc(void); }
`;

const HIP = `#include <hip/hip_runtime.h>
__global__ void saxpy(int n, float a, const float* __restrict__ x, float* __restrict__ y) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) y[i] = a * x[i] + y[i];
}
__device__ __forceinline__ float twice(float v) { return 2.0f * v; }
struct Params { __shared__ float tile[256]; int n; };
int main() {
    float *x, *y;
    saxpy<<<blocks, threads>>>(n, 2.0f, x, y);
    hipLaunchKernelGGL(saxpy, dim3(blocks), dim3(threads), 0, 0, n, 2.0f, x, y);
}
`;

describe("C++ adapter", () => {
    it("extracts namespaces, types, methods, and out-of-line definitions", async () => {
        const parsed = await parseCppFile(CPP, "/project/socket.cpp", "cpp");

        expect(parsed.parseErrors).toBe(0);
        expect(parsed.all.map((declaration) => declaration.qualifiedName)).toEqual(
            expect.arrayContaining([
                "net",
                "net::Socket",
                "net::Socket::Socket",
                "net::Socket::~Socket",
                "net::Socket::connect",
                "net::Socket::count",
                "net::Socket::fd_",
                "net::Socket::value_",
                "net::Socket::operator bool",
                "Alias",
                "MyInt",
                "Color",
                "Color::Red",
                "Color::Green",
                "Point",
                "Point::x",
                "Point::y",
                "a::b",
                "a::b::f",
                "cfunc",
            ]),
        );

        const declared = parsed.all.find(
            (declaration) =>
                declaration.qualifiedName === "net::Socket::connect" && !declaration.isDefinition,
        );
        const defined = parsed.all.find(
            (declaration) =>
                declaration.qualifiedName === "net::Socket::connect" && declaration.isDefinition,
        );

        expect(declared?.kind).toBe("method");
        expect(declared?.paramTypes).toEqual(["constAddress&"]);
        expect(declared?.paramTexts).toEqual(["const Address&"]);
        expect(defined?.kind).toBe("method");
        expect(defined?.paramTypes).toEqual(["constAddress&"]);
        expect(defined?.paramTexts).toEqual(["const Address&"]);
        expect(defined?.signature).toContain("Socket::connect");
        expect(defined?.bodyRange).toBeDefined();
    });

    it("keeps class and struct access defaults", async () => {
        const parsed = await parseCppFile(CPP, "/project/socket.cpp", "cpp");

        const socketField = parsed.all.find(
            (declaration) => declaration.qualifiedName === "net::Socket::fd_",
        );
        const pointField = parsed.all.find(
            (declaration) => declaration.qualifiedName === "Point::x",
        );

        expect(socketField?.access).toBe("private");
        expect(pointField?.access).toBe("public");
        expect(pointField?.signature).toBe("float x");
    });

    it("recovers attributes, GCC attributes, AVX prefixes, and empty defaults", async () => {
        const src = `#define VIBES_AVX2 __attribute__((target("avx2")))
#ifndef VIBES_KERNEL_HASH
#define VIBES_KERNEL_HASH "unknown"
#endif
namespace simd {
[[nodiscard]] Result<std::pair<std::string, std::string>> split(std::string_view spec) { return {}; }
using Halves = __attribute__((ext_vector_type(8))) _Float16;
VIBES_AVX2 inline __m256i lanes_at(const std::uint8_t* at) noexcept { return {}; }
VIBES_AVX2_FMA float dot_row(const float* a, std::int64_t count);
void configure(const Header& header = {}, int x = 0);
}
`;
        const parsed = await parseCppFile(src, "/project/simd.cpp", "cpp");

        expect(parsed.parseErrors).toBe(0);
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "simd::split"),
        ).toBeDefined();
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "simd::Halves")
                ?.signature,
        ).toContain("_Float16");
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "simd::lanes_at"),
        ).toBeDefined();
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "simd::dot_row"),
        ).toBeDefined();
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "simd::configure"),
        ).toBeDefined();
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "simd::lanes_at")
                ?.signature,
        ).toContain("VIBES_AVX2");
    });

    it("keeps declaration macros out of the parser but in the signature", async () => {
        const src = `FMT_BEGIN_NAMESPACE
FMT_EXPORT template <typename T> class Store {
public:
  FMT_CONSTEXPR Store();
  FMT_API void push(const T& value);
};
FMT_END_NAMESPACE
`;
        const parsed = await parseCppFile(src, "/project/store.h", "cpp");
        const store = parsed.all.find((declaration) => declaration.qualifiedName === "Store");
        const ctor = parsed.all.find((declaration) => declaration.qualifiedName === "Store::Store");
        const push = parsed.all.find((declaration) => declaration.qualifiedName === "Store::push");

        expect(parsed.parseErrors).toBe(0);
        expect(store?.signature).toContain("FMT_EXPORT");
        expect(store?.signature).toContain("template <typename T>");
        expect(ctor?.signature).toContain("FMT_CONSTEXPR");
        expect(push?.signature).toContain("FMT_API");
    });

    it("keeps a forward declaration and its definition as separate declarations", async () => {
        const src = `class Foo;
class Foo {
public:
  void bar();
};
`;
        const parsed = await parseCppFile(src, "/project/foo.cpp", "cpp");
        const declarations = parsed.all.filter(
            (declaration) => declaration.qualifiedName === "Foo",
        );

        expect(declarations).toHaveLength(2);
        expect(declarations.some((declaration) => declaration.isDefinition)).toBe(true);
        expect(declarations.some((declaration) => !declaration.isDefinition)).toBe(true);
    });

    it("dedupes declarations repeated in preprocessor branches", async () => {
        const src = `#ifdef A
void f();
#else
void f();
#endif
`;
        const parsed = await parseCppFile(src, "/project/foo.cpp", "cpp");

        expect(parsed.all.filter((declaration) => declaration.qualifiedName === "f")).toHaveLength(
            1,
        );
    });

    it("neutralizes HIP qualifiers and launch syntax without losing source text", async () => {
        const parsed = await parseCppFile(HIP, "/project/saxpy.hip", "hip");

        expect(parsed.parseErrors).toBe(0);

        const kernel = parsed.all.find((declaration) => declaration.qualifiedName === "saxpy");
        const device = parsed.all.find((declaration) => declaration.qualifiedName === "twice");

        expect(kernel?.kind).toBe("function");
        expect(kernel?.isDefinition).toBe(true);
        expect(kernel?.signature).toContain("__global__");
        expect(kernel?.signature).toContain("__restrict__");
        expect(device?.signature).toContain("__device__");
        expect(device?.signature).toContain("__forceinline__");
    });

    it("extracts named lambdas and nested lambdas from function bodies", async () => {
        const src = `void dequant() {
  const int local = 1;
  const auto decode = [=](int first, int last) {
    const auto decode_row = [&](float* target) { target[0] = 1.0f; };
    decode_row(nullptr);
  };
  decode(0, 1);
}
`;
        const parsed = await parseCppFile(src, "/project/dequant.cpp", "cpp");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(names).toContain("dequant::decode");
        expect(names).toContain("dequant::decode::decode_row");
        expect(names).not.toContain("dequant::local");
        expect(
            parsed.all.find((declaration) => declaration.qualifiedName === "dequant::decode")?.kind,
        ).toBe("function");
        expect(
            parsed.all.find(
                (declaration) => declaration.qualifiedName === "dequant::decode::decode_row",
            )?.paramTypes,
        ).toEqual(["float*"]);
    });
});
