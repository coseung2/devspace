import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const env = { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-test" };

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env,
  }).trim();

  assert.equal(output, packageJson.version);
}

const help = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--help"], {
  encoding: "utf8",
  env,
});
assert.doesNotMatch(help, /devspace agents/);

const removedCommand = spawnSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "agents", "ls"],
  { encoding: "utf8", env },
);
assert.notEqual(removedCommand.status, 0);
assert.match(removedCommand.stderr, /Unknown command: agents/);
