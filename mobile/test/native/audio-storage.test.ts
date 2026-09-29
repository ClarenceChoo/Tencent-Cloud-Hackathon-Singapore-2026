import { beforeEach, expect, it, vi } from "vitest";
const filesystem = vi.hoisted(() => ({
  entries: new Map<string, "file" | "directory">(),
  deleted: [] as string[],
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "device-only",
}));
vi.mock("expo-crypto", () => ({}));
vi.mock("expo-file-system", () => {
  const uri = (parts: Array<string | { uri: string }>) =>
    "file:///" +
    parts
      .map((p) => (typeof p === "string" ? p : p.uri))
      .join("/")
      .replace(/^file:\/+/, "")
      .replace(/\/+/g, "/");
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = uri(parts);
    }
    get exists() {
      return filesystem.entries.get(this.uri) === "file";
    }
    get name() {
      return this.uri.split("/").at(-1);
    }
    delete() {
      filesystem.deleted.push(this.uri);
      filesystem.entries.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = uri(parts).replace(/\/?$/, "/");
    }
    get exists() {
      return filesystem.entries.get(this.uri) === "directory";
    }
    list() {
      if (!this.exists) throw new Error("Directory does not exist");
      return [...filesystem.entries]
        .filter(
          ([child]) =>
            child.startsWith(this.uri) &&
            child !== this.uri &&
            !child.slice(this.uri.length).replace(/\/$/, "").includes("/"),
        )
        .map(([child, kind]) =>
          kind === "file" ? new File(child) : new Directory(child),
        );
    }
  }
  return {
    File,
    Directory,
    Paths: {
      cache: { uri: "file:///cache/" },
      document: { uri: "file:///document/" },
    },
  };
});
import { sweepAudio } from "../../src/storage";
beforeEach(() => {
  filesystem.entries.clear();
  filesystem.deleted.length = 0;
  filesystem.entries.set("file:///cache/", "directory");
});
it("startup cleanup removes orphaned recordings in both native recorder subdirectories", () => {
  for (const directory of ["Audio", "ExpoAudio"]) {
    filesystem.entries.set(`file:///cache/${directory}/`, "directory");
    filesystem.entries.set(
      `file:///cache/${directory}/recording-killed.m4a`,
      "file",
    );
  }
  filesystem.entries.set("file:///cache/recording-legacy.m4a", "file");
  filesystem.entries.set("file:///cache/parse-reply-expired.wav", "file");
  sweepAudio();
  expect(filesystem.deleted.sort()).toEqual(
    [
      "file:///cache/Audio/recording-killed.m4a",
      "file:///cache/ExpoAudio/recording-killed.m4a",
      "file:///cache/parse-reply-expired.wav",
      "file:///cache/recording-legacy.m4a",
    ].sort(),
  );
});
it("missing recorder folders are harmless and unrelated files/directories remain untouched", () => {
  filesystem.entries.set("file:///cache/thumbnail.jpg", "file");
  filesystem.entries.set("file:///cache/recording-attachments/", "directory");
  filesystem.entries.set(
    "file:///cache/recording-attachments/recording-owned-elsewhere.m4a",
    "file",
  );
  filesystem.entries.set("file:///document/recording-document.m4a", "file");
  const before = new Map(filesystem.entries);
  sweepAudio();
  expect(filesystem.entries).toEqual(before);
  expect(filesystem.deleted).toEqual([]);
});
