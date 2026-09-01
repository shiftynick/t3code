import { assert, describe, it } from "vite-plus/test";

import { resolveArchiveExtractionCommand } from "./ensure-electron-runtime.mjs";

describe("Electron runtime archive extraction", () => {
  it("uses PowerShell on Windows without requiring Python", () => {
    const extraction = resolveArchiveExtractionCommand("win32", "electron.zip", "dist");

    assert.strictEqual(extraction.command, "powershell.exe");
    assert.match(extraction.args.join(" "), /Expand-Archive/);
    assert.deepStrictEqual(extraction.environment, {
      T3CODE_ELECTRON_ARCHIVE_PATH: "electron.zip",
      T3CODE_ELECTRON_DESTINATION_PATH: "dist",
    });
  });

  it("keeps the native macOS and Unix extractors", () => {
    assert.deepStrictEqual(resolveArchiveExtractionCommand("darwin", "electron.zip", "dist"), {
      command: "ditto",
      args: ["-x", "-k", "electron.zip", "dist"],
    });
    assert.strictEqual(
      resolveArchiveExtractionCommand("linux", "electron.zip", "dist").command,
      "python3",
    );
  });
});
