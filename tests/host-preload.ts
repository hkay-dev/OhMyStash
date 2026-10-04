import { mock } from "bun:test";

// Browser tests use the in-app editor and must not launch Windows Notepad.
mock.module(import.meta.resolve("@oh-my-pi/pi-coding-agent/utils/external-editor"), () => ({
  getEditorCommand: () => process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || undefined,
  openInEditor: async () => {
    throw new Error("External editors are disabled in browser tests");
  },
}));
