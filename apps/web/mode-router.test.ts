import { describe, it, expect } from "vitest";
import { classifyMode } from "./lib/mode-router";

describe("mode router — precedence + prefix parsing", () => {
  it("defaults a plain question to RAG (local tier)", () => {
    expect(classifyMode("what is in my notes?")).toEqual({
      mode: "rag",
      tier: "local",
      q: "what is in my notes?",
    });
  });

  it("preserves the `!` direct family exactly (delegates to parseQueryRoute)", () => {
    expect(classifyMode("!who are you")).toMatchObject({ mode: "direct", tier: "local", q: "who are you" });
    expect(classifyMode("!!who are you")).toMatchObject({ mode: "direct", tier: "frontier-cheap" });
    expect(classifyMode("!!!think hard")).toMatchObject({ mode: "direct", tier: "frontier-flagship", q: "think hard" });
  });

  it("preserves the `+` RAG-frontier family exactly", () => {
    expect(classifyMode("+summarize")).toMatchObject({ mode: "rag", tier: "frontier-cheap", q: "summarize" });
    expect(classifyMode("++deep dive")).toMatchObject({ mode: "rag", tier: "frontier-flagship", q: "deep dive" });
  });

  it("routes /run to Command and strips the verb", () => {
    expect(classifyMode("/run node --version")).toEqual({ mode: "command", goal: "node --version" });
    expect(classifyMode("/RUN ls")).toEqual({ mode: "command", goal: "ls" });
    expect(classifyMode("/run")).toEqual({ mode: "command", goal: "" });
  });

  it("opens an Agent session with /agent (when not already in one)", () => {
    expect(classifyMode("/agent find the node version")).toEqual({
      mode: "agent",
      goal: "find the node version",
      opened: true,
    });
    expect(classifyMode("/agent")).toEqual({ mode: "agent", goal: "", opened: true });
  });

  it("treats an empty input as noop", () => {
    expect(classifyMode("   ")).toEqual({ mode: "noop" });
  });

  describe("inside an open Agent session", () => {
    const inSession = { inAgentSession: true };

    it("continues the loop for plain input (opened:false)", () => {
      expect(classifyMode("now check the disk", inSession)).toEqual({
        mode: "agent",
        goal: "now check the disk",
        opened: false,
      });
    });

    it("exits the session on /done", () => {
      expect(classifyMode("/done", inSession)).toEqual({ mode: "exit-agent" });
      expect(classifyMode("/DONE", inSession)).toEqual({ mode: "exit-agent" });
    });

    it("treats /done OUTSIDE a session as ordinary text → RAG", () => {
      expect(classifyMode("/done")).toMatchObject({ mode: "rag", q: "/done" });
    });

    it("lets a per-message prefix override the session (!, +)", () => {
      expect(classifyMode("!quick aside", inSession)).toMatchObject({ mode: "direct", tier: "local" });
      expect(classifyMode("+grounded aside", inSession)).toMatchObject({ mode: "rag", tier: "frontier-cheap" });
    });

    it("lets /run override the session", () => {
      expect(classifyMode("/run uname -a", inSession)).toEqual({ mode: "command", goal: "uname -a" });
    });

    it("continues (not re-opens) when /agent is typed mid-session", () => {
      expect(classifyMode("/agent another step", inSession)).toEqual({
        mode: "agent",
        goal: "another step",
        opened: false,
      });
    });
  });

  describe("precedence ordering", () => {
    it("ranks /run above the prefix grammar", () => {
      // "/run !foo" is a command whose goal text happens to start with '!'.
      expect(classifyMode("/run !foo")).toEqual({ mode: "command", goal: "!foo" });
    });

    it("ranks a real prefix above /agent and the session", () => {
      // A leading sigil wins even when the rest looks like a slash command.
      expect(classifyMode("!/agent x", { inAgentSession: true })).toMatchObject({ mode: "direct" });
    });
  });
});
