import { describe, expect, it } from "vitest";

import { parseCodeFile } from "../../../src/tools/code/parse";

const JAVA = `package com.acme.app;

/** A service. */
public final class Service<T> extends Base implements Api {
  private int count;
  public Service(int count) { this.count = count; }
  @Override public String run(final int value, List<T> items) { return helper(value); }
  static int helper(int value) { return value + 1; }
  class Inner { void go() {} }
}
interface Api { void run(int value); }
enum Kind { A, B; }
`;

const CSHARP = `namespace Acme.App;

public sealed class Service<T> : Base, IApi {
  private int count;
  public Service(int count) { this.count = count; }
  public string Run(int value) => Helper(value);
  private static int Helper(int value) { return value + 1; }
  public int Count { get; set; }
  class Inner { void Go() {} }
}
public interface IApi { void Run(int value); }
public enum Kind { A, B }
`;

const GO = `package service

type Service struct { count int }
type Api interface { Run(value int) error }
func NewService(count int) *Service { return &Service{count: count} }
func (s *Service) Run(value int) error { return nil }
func helper(value int) int { return value + 1 }
const Answer = 42
`;

const RUST = `pub mod service {
  pub struct Service { count: i32 }
  pub trait Api { fn run(&self, value: i32) -> Result<(), String>; }
  impl Service {
    pub fn new(count: i32) -> Self { Self { count } }
    pub fn run(&self, value: i32) -> Result<(), String> { Ok(()) }
  }
  pub fn helper(value: i32) -> i32 { value + 1 }
  pub const ANSWER: i32 = 42;
}
`;

const PYTHON = `TIMEOUT = 30
NAMES = ["a", "b"]

class Service(Base):
    """docs"""
    count: int = 0

    def __init__(self, count: int):
        self.count = count

    async def run(self, value: int, *args, **kwargs) -> str:
        def helper(x):
            return x + 1
        return helper(value)

    @property
    def size(self):
        return self.count

def helper(value: int = 1) -> int:
    scratch = value * 2
    return scratch + 1
`;

const PHP = `<?php
namespace Acme\\App;

class Service extends Base implements Api {
  private int $count = 0;
  public function __construct(int $count) { $this->count = $count; }
  public function run(int $value): string { return $this->helper($value); }
  private function helper(int $value): int { return $value + 1; }
}
interface Api { public function run(int $value): string; }
trait Helper { public function go(): void {} }
function helper(int $value = 1): int { return $value + 1; }
const ANSWER = 42;
`;

const RUBY = `LIMIT = 10

module Acme
  class Service < Base
    def initialize(count)
      @count = count
    end

    def run(value)
      helper = ->(x) { x + 1 }
      helper.call(value)
    end

    def self.build
      new(1)
    end
  end

  def helper(value = 1)
    value + 1
  end
end
`;

describe("multi-language adapters", () => {
    it("extracts Java packages, classes, members, and parameters", async () => {
        const parsed = await parseCodeFile(JAVA, "/project/Service.java", "java");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual(
            expect.arrayContaining([
                "com::acme::app::Service",
                "com::acme::app::Service::count",
                "com::acme::app::Service::Service",
                "com::acme::app::Service::run",
                "com::acme::app::Service::Inner",
                "com::acme::app::Api",
                "com::acme::app::Kind::A",
            ]),
        );
        expect(
            parsed.all.find((item) => item.qualifiedName.endsWith("Service::run"))?.paramTypes,
        ).toEqual(["int", "List<T>"]);
        expect(parsed.all.find((item) => item.qualifiedName.endsWith("Service::run"))?.access).toBe(
            "public",
        );
    });

    it("extracts C# namespaces, classes, expression bodies, and properties", async () => {
        const parsed = await parseCodeFile(CSHARP, "/project/Service.cs", "csharp");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual(
            expect.arrayContaining([
                "Acme::App::Service",
                "Acme::App::Service::Run",
                "Acme::App::Service::Count",
                "Acme::App::Service::Inner",
                "Acme::App::IApi::Run",
            ]),
        );
        expect(
            parsed.all.find((item) => item.qualifiedName.endsWith("Service::Run"))?.bodyRange,
        ).toBeDefined();
        expect(parsed.all.find((item) => item.qualifiedName.endsWith("Service::Count"))?.kind).toBe(
            "field",
        );
    });

    it("extracts Go types, receiver methods, fields, and constants", async () => {
        const parsed = await parseCodeFile(GO, "/project/service.go", "go");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual(
            expect.arrayContaining([
                "service::Service",
                "service::Service::count",
                "service::Service::Run",
                "service::Api::Run",
                "service::NewService",
                "service::Answer",
            ]),
        );
        expect(
            parsed.all.find((item) => item.qualifiedName === "service::Service::Run")?.paramTypes,
        ).toEqual(["int"]);
    });

    it("extracts Rust modules, structs, traits, impl methods, and constants", async () => {
        const parsed = await parseCodeFile(RUST, "/project/service.rs", "rust");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual(
            expect.arrayContaining([
                "service",
                "service::Service",
                "service::Service::count",
                "service::Api::run",
                "service::Service::new",
                "service::Service::run",
                "service::helper",
                "service::ANSWER",
            ]),
        );
        expect(
            parsed.all.find((item) => item.qualifiedName === "service::Service::run")?.kind,
        ).toBe("method");
    });

    it("extracts Python classes, decorated methods, and nested functions", async () => {
        const parsed = await parseCodeFile(PYTHON, "/project/service.py", "python");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual(
            expect.arrayContaining([
                "Service",
                "Service::__init__",
                "Service::run",
                "Service::run::helper",
                "Service::size",
                "helper",
                "TIMEOUT",
                "NAMES",
            ]),
        );
        // A binding inside a function body is a local, not a declaration in the file's map.
        expect(names).not.toContain("helper::scratch");
        expect(
            parsed.all.find((item) => item.qualifiedName === "Service::run")?.paramTypes,
        ).toEqual(["int"]);
    });

    it("extracts PHP namespaces, classes, traits, methods, and constants", async () => {
        const parsed = await parseCodeFile(PHP, "/project/Service.php", "php");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual(
            expect.arrayContaining([
                "Acme::App::Service",
                "Acme::App::Service::run",
                "Acme::App::Service::helper",
                "Acme::App::Api::run",
                "Acme::App::Helper::go",
                "Acme::App::helper",
                "Acme::App::ANSWER",
            ]),
        );
        expect(parsed.all.find((item) => item.qualifiedName === "Acme::App::Helper")?.kind).toBe(
            "trait",
        );
    });

    it("extracts Ruby modules, classes, instance methods, and singleton methods", async () => {
        const parsed = await parseCodeFile(RUBY, "/project/service.rb", "ruby");
        const names = parsed.all.map((declaration) => declaration.qualifiedName);

        expect(parsed.parseErrors).toBe(0);
        expect(names).toEqual(
            expect.arrayContaining([
                "Acme",
                "Acme::Service",
                "Acme::Service::initialize",
                "Acme::Service::run",
                "Acme::Service::build",
                "Acme::helper",
                "LIMIT",
            ]),
        );
    });
});
