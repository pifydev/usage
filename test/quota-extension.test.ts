import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// A child keeps Pi's agent directory and module cache isolated from other tests.
test("quota command integrates Pi OAuth, provider-specific footer and coexisting extensions without live access", () => {
  const dir = mkdtempSync(join(tmpdir(), "pify-usage-test-"));
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      (async () => {
        const assert = (await import("node:assert/strict")).default;
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const sdk = await import("@earendil-works/pi-coding-agent");
        assert.equal(sdk.getAgentDir(), process.env.PI_CODING_AGENT_DIR);
        const credentials = {
          "github-copilot": { type: "oauth", refresh: "synthetic-github", access: "synthetic-inference", expires: 0 },
          "openai-codex": { type: "oauth", refresh: "synthetic-refresh", access: "synthetic-old-access", expires: 0 }
        };
        const persistAuth = () => writeFileSync(join(sdk.getAgentDir(), "auth.json"), JSON.stringify(credentials), { mode: 0o600 });
        persistAuth();
        const token = "test." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url") + ".signature";
        const requests = [];
        let rejectCodex = false;
        globalThis.fetch = async (url, init) => {
          requests.push({ url, headers: new Headers(init.headers) });
          assert.equal(init.redirect, "error");
          if (url === "https://api.github.com/copilot_internal/user" || url === "https://api.example.ghe.com/copilot_internal/user") {
            assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-github");
            return new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { percent_remaining: 49 } }, quota_reset_date: new Date(Date.now() + 3600000).toISOString() }));
          }
          assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
          assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + token);
          assert.equal(new Headers(init.headers).get("ChatGPT-Account-Id"), "synthetic-account");
          return rejectCodex ? new Response(token, { status: 503 }) : new Response(JSON.stringify({ rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18000 },
            secondary_window: { used_percent: 60, limit_window_seconds: 604800 }
          } }));
        };
        const { default: usage } = await import(${JSON.stringify(new URL("../extensions/usage.ts", import.meta.url).href)});
        const handlers = new Map();
        const commands = new Map();
        let tool;
        usage({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, { name, ...command }), registerTool: value => { tool = value; } });
        assert.equal(commands.get("usage").handler, commands.get("pify-usage").handler);
        const legacyHandler = () => undefined;
        const legacyCommands = new Map([["usage", { name: "usage", handler: legacyHandler }]]);
        const runner = new sdk.ExtensionRunner([{ commands }, { commands: legacyCommands }], sdk.createExtensionRuntime(), process.cwd(), {}, {});
        assert.equal(runner.getCommand("pify-usage").handler, commands.get("usage").handler);
        assert.equal(runner.getCommand("usage:1").handler, commands.get("usage").handler);
        assert.equal(runner.getCommand("usage:2").handler, legacyHandler);
        assert.equal(runner.getCommand("usage"), undefined);
        const statuses = new Map([["usage", "legacy footer"]]);
        const notifications = [];
        const authCalls = [];
        const ctx = {
          hasUI: true, model: { provider: "github-copilot", contextWindow: 272000 },
          sessionManager: { getBranch: () => [] },
          modelRegistry: { getApiKeyForProvider: async id => {
            authCalls.push(id);
            assert.notEqual(id, "github-copilot", "never resolve an inference token for quota");
            if (id === "openrouter") return "synthetic-unused-openrouter-key";
            if (id !== "openai-codex") return undefined;
            credentials["openai-codex"].access = token;
            persistAuth();
            return token;
          } },
          ui: { setStatus: (key, value) => statuses.set(key, value), notify: text => notifications.push(text) }
        };
        await handlers.get("session_start")({ reason: "start" }, ctx);
        await handlers.get("model_select")({}, ctx);
        await tool.execute("synthetic", {}, undefined, undefined, ctx);
        assert.equal(requests.length, 0);
        assert.equal(authCalls.length, 0);
        await commands.get("pify-usage").handler("quota", ctx);
        assert.equal(requests.length, 1, "only the active provider may be queried");
        assert.equal(authCalls.length, 0, "do not resolve unrelated credentials");
        assert.ok(!notifications.join("\\n").includes("OpenRouter"));
        assert.match(statuses.get("pify-usage"), /Copilot.*49% left.*cached/);
        assert.equal(statuses.get("usage"), "legacy footer");
        ctx.model.provider = "openai-codex";
        await handlers.get("model_select")({}, ctx);
        assert.equal(statuses.get("pify-usage"), undefined);
        assert.equal(requests.length, 1);
        await commands.get("pify-usage").handler("quota", ctx);
        assert.equal(requests.length, 2);
        assert.match(statuses.get("pify-usage"), /Codex.*75% left.*40% left/);
        rejectCodex = true;
        await commands.get("pify-usage").handler("quota", ctx);
        assert.equal(requests.length, 3);
        assert.match(statuses.get("pify-usage"), /Codex quota unavailable/);
        assert.ok(!notifications.join("\\n").includes(token));
        assert.ok(!notifications.join("\\n").includes("synthetic-github"));
        await handlers.get("session_start")({ reason: "reload" }, ctx);
        assert.equal(statuses.get("pify-usage"), undefined);
        await handlers.get("session_shutdown")({}, ctx);
        assert.equal(statuses.get("usage"), "legacy footer");
        assert.equal(requests.length, 3);
        credentials["github-copilot"].enterpriseUrl = "example.ghe.com";
        delete credentials["openai-codex"];
        persistAuth();
        ctx.model.provider = "github-copilot";
        await commands.get("pify-usage").handler("quota", ctx);
        assert.equal(requests.length, 4);
        assert.equal(requests.at(-1).url, "https://api.example.ghe.com/copilot_internal/user");
        assert.match(statuses.get("pify-usage"), /Copilot.*49% left/);
        credentials["github-copilot"].enterpriseUrl = "example.ghe.com.evil.invalid";
        persistAuth();
        await commands.get("pify-usage").handler("quota", ctx);
        assert.equal(requests.length, 4, "invalid authorities must never fall back to public GitHub");
        assert.match(statuses.get("pify-usage"), /unavailable/);
        assert.match(notifications.at(-1), /unsupported.*authority/i);
        ctx.model.provider = "unsupported-provider";
        await commands.get("pify-usage").handler("quota", ctx);
        assert.equal(requests.length, 4);
        assert.match(notifications.at(-1), /active provider/);
        assert.equal(statuses.get("pify-usage"), undefined, "never retain another provider's quota in the footer");
        assert.ok(authCalls.every(id => id === "openai-codex"));
        console.log("extension integration: OK");
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: new URL("..", import.meta.url), env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8", timeout: 30000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /extension integration: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
