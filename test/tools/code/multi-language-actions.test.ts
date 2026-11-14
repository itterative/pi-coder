import { beforeEach, describe, expect, it } from "vitest";

import { runDigest } from "../../../src/tools/code/digest";
import { clearCodeCache } from "../../../src/tools/code/load";
import { runShow } from "../../../src/tools/code/show";
import { runUsages } from "../../../src/tools/code/usages";
import { MemoryCodeSource } from "../../helpers/code-source";

const FILES: Record<string, string> = {
    "src/java/Service.java": `package com.acme;

class Service {
  int helper(int value) { return value + 1; }
  int run(int value) { return helper(value); }
}

class Main {
  void main() { new Service().run(1); }
}
`,
    "src/csharp/Service.cs": `namespace Acme;

class Service {
  int Helper(int value) { return value + 1; }
  int Run(int value) { return Helper(value); }
}

class Main {
  void Main() { new Service().Run(1); }
}
`,
    "src/go/service.go": `package service

func NewService() int { return 1 }
func helper(value int) int { return value + 1 }
func main() { NewService(); helper(1) }
`,
    "src/rust/service.rs": `pub struct Service;

impl Service {
    pub fn new() -> Self { Self }
    pub fn run(&self) -> i32 { helper(1) }
}

pub fn helper(value: i32) -> i32 { value + 1 }

pub fn main() { Service::new(); helper(1); }
`,
    "src/python/service.py": `TIMEOUT = 30

class Service:
    def run(self, value):
        return helper(value)

def helper(value):
    return value + 1
`,
    "src/php/Service.php": `<?php
namespace Acme;

class Service {
  public function run(int $value): int { return $this->helper($value); }
  private function helper(int $value): int { return $value + 1; }
}
function helper(int $value): int { return $value + 1; }
`,
    "src/ruby/service.rb": `LIMIT = 10

class Service
  ANSWER = 42

  def self.build
    new
  end
end

Service.build
`,
};

function source(): MemoryCodeSource {
    return new MemoryCodeSource("/project", FILES);
}

beforeEach(() => {
    clearCodeCache();
});

describe("outline on the extended language set", () => {
    it("discovers and digests every adapter", async () => {
        const result = await runDigest(source(), {
            action: "digest",
            path: "src",
        });

        expect(result.text).toContain(
            "# digest src · 7 files · csharp,go,java,php,python,ruby,rust ·",
        );
        expect(result.text).toContain("class Service");
        expect(result.text).toContain("struct Service");
        expect(result.parseErrors).toBe(0);
    });

    it("lists Python and Ruby module constants in a digest", async () => {
        const python = await runDigest(source(), {
            action: "digest",
            path: "src/python/service.py",
        });
        const ruby = await runDigest(source(), {
            action: "digest",
            path: "src/ruby/service.rb",
            detail: "full",
        });

        expect(python.text).toContain("TIMEOUT = 30");
        // A constant inside a class body is a member, so it arrives with detail=full.
        expect(ruby.text).toContain("ANSWER = 42");
        expect(ruby.text).toContain("LIMIT = 10");
    });

    it.each([
        ["src/java/Service.java", "Service::run", "return helper(value)"],
        ["src/csharp/Service.cs", "Service::Run", "return Helper(value)"],
        ["src/go/service.go", "service::NewService", "return 1"],
        ["src/rust/service.rs", "Service::run", "helper(1)"],
        ["src/python/service.py", "Service::run", "return helper(value)"],
        ["src/php/Service.php", "Service::run", "return $this->helper"],
        ["src/ruby/service.rb", "Service::build", "new"],
    ])("shows a %s declaration", async (file, symbol, body) => {
        const result = await runShow(source(), {
            action: "show",
            path: file,
            query: symbol,
        });

        expect(result.text).toContain(`# ${file}`);
        expect(result.text).toContain(body);
    });

    it.each([
        ["src/java/Service.java", "helper"],
        ["src/csharp/Service.cs", "Helper"],
        ["src/go/service.go", "NewService"],
        ["src/rust/service.rs", "new"],
        ["src/python/service.py", "helper"],
        ["src/php/Service.php", "helper"],
        ["src/ruby/service.rb", "build"],
    ])("classifies calls and definitions in %s", async (file, symbol) => {
        const result = await runUsages(source(), {
            action: "usages",
            path: file,
            query: symbol,
        });

        expect(result.text).toContain("[def]");
        expect(result.text).toContain("[call]");
        expect(result.matches).toBeGreaterThanOrEqual(2);
    });
});
