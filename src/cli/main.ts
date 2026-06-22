#!/usr/bin/env node

/**
 * Meridian CLI
 *
 * Commands:
 *   add <provider>        Generate a provider package from its OpenAPI spec
 *   generate | gen        Generate from explicit flags (legacy form)
 *   migrate <provider>    Scan a codebase for direct SDK/HTTP usage of a provider
 *   replay <name>         Replay a recorded reliability session
 *   registry <action>     Contract registry: snapshot | check | report | list
 *   studio                Start the Meridian Studio HTTP API (disk-only;
 *                         pair with the Meridian Studio dashboard app, or
 *                         call `await meridian.studio()` in-process for live data)
 *
 * Run `meridian help <command>` for per-command flags.
 */

import { readFile } from "node:fs/promises";
import { addProvider, formatAddResult } from "../generator/add.js";
import { type GeneratorOptions, generate } from "../generator/index.js";
import { listKnownProviders } from "../generator/registry.js";
import { formatMigrationReport, scanForMigration } from "../migrate/scanner.js";
import { ContractRegistry } from "../registry/contract-registry.js";
import { renderTimeline, replaySession } from "../replay/replayer.js";
import { ReliabilityStore } from "../replay/store.js";
import { createStudioServer, type StudioServerOptions } from "../studio/server.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[], booleanFlags: ReadonlySet<string>): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (booleanFlags.has(key) || i + 1 >= argv.length || argv[i + 1]!.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = argv[++i]!;
    }
  }
  return { positional, flags };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): number {
  process.stderr.write(`Error: ${message}\n`);
  return 1;
}

const USAGE = `Meridian CLI

Usage: meridian <command> [options]

Commands:
  add <provider>          Generate adapter + contract tests + pagination from an
                          OpenAPI spec ("meridian add --list" shows registered specs)
  generate | gen          Legacy generator: --provider <name> [--openapi <path>] …
  migrate <provider>      Scan a codebase for direct SDK usage and report what
                          maps to Meridian (read-only; supports --json)
  replay <name>           Replay a recorded reliability session from
                          .meridian/recordings ("meridian replay --list")
  registry <action>       snapshot | check | report | list — versioned response
                          schemas with drift history in .meridian/registry
  studio                  Start the Meridian Studio HTTP API: --port --host
                          --token --origin --registry-dir --recordings-dir
                          (disk-only here; call meridian.studio() in-process
                          for live health/cost/circuit-breaker data)
  help                    Show this message
`;

async function runAdd(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, new Set(["force", "list"]));

  if (flags.list) {
    out("Providers with registered OpenAPI specs:");
    for (const p of listKnownProviders()) {
      out(`  ${p.name.padEnd(10)} ${p.displayName} — ${p.docsUrl}`);
    }
    out("");
    out("Anything else: meridian add <provider> --openapi <url-or-path>");
    return 0;
  }

  const provider = positional[0];
  if (!provider) {
    return fail(
      "Usage: meridian add <provider> [--openapi <url-or-path>] [--output <dir>] [--force]",
    );
  }

  const opts: Parameters<typeof addProvider>[0] = { provider };
  if (typeof flags.openapi === "string") opts.openapi = flags.openapi;
  if (typeof flags.output === "string") opts.output = flags.output;
  if (typeof flags["base-url"] === "string") opts.baseUrl = flags["base-url"];
  if (typeof flags.auth === "string") opts.auth = flags.auth as NonNullable<typeof opts.auth>;
  if (flags.force === true) opts.force = true;

  const result = await addProvider(opts);
  out(formatAddResult(result));
  return 0;
}

async function runGenerate(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, new Set());
  if (typeof flags.provider !== "string") {
    return fail(
      "Usage: meridian generate --provider <name> [--openapi <path>] [--base-url <url>] [--auth <type>] [--output <dir>]",
    );
  }
  const opts: GeneratorOptions = { provider: flags.provider };
  if (typeof flags.openapi === "string") opts.openapi = flags.openapi;
  if (typeof flags["base-url"] === "string") opts.baseUrl = flags["base-url"];
  if (typeof flags.auth === "string")
    opts.auth = flags.auth as NonNullable<GeneratorOptions["auth"]>;
  if (typeof flags.output === "string") opts.output = flags.output;
  await generate(opts);
  return 0;
}

async function runMigrate(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, new Set(["json"]));
  const provider = positional[0];
  if (!provider) {
    return fail("Usage: meridian migrate <provider> [path] [--json]");
  }
  const root = positional[1] ?? ".";
  const report = await scanForMigration(provider, root);
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(formatMigrationReport(report));
  }
  return 0;
}

async function runReplay(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, new Set(["list", "summary"]));
  const dir = typeof flags.dir === "string" ? flags.dir : undefined;
  const store = new ReliabilityStore(dir);

  if (flags.list) {
    const sessions = await store.list();
    if (sessions.length === 0) {
      out("No recorded sessions. Capture one with meridian.startRecording(<name>).");
    } else {
      for (const s of sessions) out(s);
    }
    return 0;
  }

  const name = positional[0];
  if (!name) {
    return fail(
      "Usage: meridian replay <name> [--dir <recordings-dir>] [--speed <factor>] [--list]",
    );
  }

  const session = await store.load(name);

  const speedFlag = typeof flags.speed === "string" ? Number(flags.speed) : undefined;
  if (speedFlag !== undefined && (!Number.isFinite(speedFlag) || speedFlag <= 0)) {
    return fail("--speed must be a positive number (e.g. --speed 10 for 10× speed).");
  }

  if (speedFlag === undefined) {
    // Instant render: the full timeline plus the derived summary.
    out(renderTimeline(session));
    return 0;
  }

  // Paced replay: stream events at the recorded rhythm, time-scaled.
  out(`Replaying "${name}" at ${speedFlag}× …\n`);
  await replaySession(session, {
    speed: speedFlag,
    onEvent: (e) => {
      const stamp = `${(e.offsetMs / 1000).toFixed(3)}s`.padStart(9);
      if (e.type === "request")
        out(`${stamp}  ${e.provider.padEnd(12)} ${e.method} ${e.endpoint} …`);
      else if (e.type === "response")
        out(
          `${stamp}  ${e.provider.padEnd(12)} ${e.method} ${e.endpoint} → ${e.statusCode} (${e.duration ?? "?"}ms)`,
        );
      else
        out(
          `${stamp}  ${e.provider.padEnd(12)} ${e.method} ${e.endpoint} ✗ ${e.errorCategory}: ${e.errorMessage}`,
        );
    },
  });
  const timeline = renderTimeline(session);
  const summaryIdx = timeline.indexOf("\nSummary\n");
  out(summaryIdx >= 0 ? timeline.slice(summaryIdx + 1) : "");
  return 0;
}

async function runRegistry(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, new Set());
  const action = positional[0];
  const dir = typeof flags.dir === "string" ? flags.dir : undefined;
  const registry = new ContractRegistry(dir);
  const provider = typeof flags.provider === "string" ? flags.provider : undefined;
  const endpoint = typeof flags.endpoint === "string" ? flags.endpoint : undefined;

  const usage =
    "Usage: meridian registry <snapshot|check|report|list> --provider <name> [--endpoint <path>] [--data <sample.json>] [--dir <registry-dir>]";

  async function loadSample(): Promise<unknown> {
    if (typeof flags.data !== "string") {
      throw new Error("--data <file.json> is required (a sample JSON response body).");
    }
    return JSON.parse(await readFile(flags.data, "utf-8"));
  }

  switch (action) {
    case "snapshot": {
      if (!provider || !endpoint) return fail(usage);
      const result = await registry.snapshot(provider, endpoint, await loadSample());
      if (!result.created) {
        out(`No change — schema matches v${result.version} of ${provider} ${endpoint}.`);
      } else {
        out(`✓ Registered ${provider} ${endpoint} as v${result.version}.`);
        for (const d of result.drifts) {
          out(`  drift: [${d.severity}] ${d.type} ${d.field}`);
        }
      }
      return 0;
    }
    case "check": {
      if (!provider || !endpoint) return fail(usage);
      const result = await registry.check(provider, endpoint, await loadSample());
      if (result.againstVersion === null) {
        out(
          `No snapshot registered for ${provider} ${endpoint} — run "meridian registry snapshot" first.`,
        );
        return 0;
      }
      if (result.drifts.length === 0) {
        out(`✓ ${provider} ${endpoint} matches v${result.againstVersion}.`);
        return 0;
      }
      out(`Drift against v${result.againstVersion} of ${provider} ${endpoint}:`);
      for (const d of result.drifts) {
        out(
          `  [${d.severity}] ${d.type} ${d.field}: ${JSON.stringify(d.oldValue)} → ${JSON.stringify(d.newValue)}`,
        );
      }
      // Breaking drift fails the process — this is the CI gate.
      return result.breaking ? 1 : 0;
    }
    case "report": {
      if (!provider) return fail(usage);
      const report = await registry.report(provider);
      if (report.endpoints.length === 0) {
        out(`No endpoints registered for ${provider}.`);
        return 0;
      }
      out(`Contract report: ${provider} (generated ${report.generatedAt})`);
      for (const e of report.endpoints) {
        out(
          `  ${e.endpoint} — v${e.latestVersion}, ${e.driftEvents} drift event(s), ${e.breakingEvents} breaking, last captured ${e.lastCapturedAt}`,
        );
      }
      return 0;
    }
    case "list": {
      if (!provider) return fail(usage);
      const endpoints = await registry.list(provider);
      if (endpoints.length === 0) out(`No endpoints registered for ${provider}.`);
      for (const e of endpoints) out(e);
      return 0;
    }
    default:
      return fail(usage);
  }
}

async function runStudio(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, new Set());

  const opts: StudioServerOptions = {};
  if (typeof flags.port === "string") opts.port = Number.parseInt(flags.port, 10);
  if (typeof flags.host === "string") opts.host = flags.host;
  if (typeof flags.token === "string") opts.authToken = flags.token;
  if (typeof flags.origin === "string") opts.allowedOrigin = flags.origin;
  if (typeof flags["registry-dir"] === "string") opts.registryDir = flags["registry-dir"];
  if (typeof flags["recordings-dir"] === "string") opts.recordingsDir = flags["recordings-dir"];

  const handle = await createStudioServer(opts);
  out(`Meridian Studio API listening at ${handle.url}`);
  out("");
  out("This is a disk-only server — replay sessions and schema-drift history");
  out("are available now. Live health/cost/circuit-breaker/recording-control");
  out("endpoints need a running app: call `await meridian.studio({ ... })`");
  out("there instead of (or alongside) this CLI command.");
  out("");
  out("Open the dashboard (a separate app — see docs/studio.md for setup):");
  out(`  set the API URL to ${handle.url} on its connect screen.`);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  try {
    switch (command) {
      case "add":
        return await runAdd(rest);
      case "generate":
      case "gen":
        return await runGenerate(rest);
      case "migrate":
        return await runMigrate(rest);
      case "replay":
        return await runReplay(rest);
      case "registry":
        return await runRegistry(rest);
      case "studio":
        return await runStudio(rest);
      case "help":
      case "--help":
      case undefined:
        out(USAGE);
        return command === undefined ? 1 : 0;
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

main().then((code) => {
  process.exitCode = code;
});
