/**
 * Tests for tool-name classification (packages/core/src/journal/patterns/tool-classes.ts).
 *
 * 6.0.0 renamed MCP tool names from dot-notation to underscore-notation.
 * The classification sets must keep classifying every naming scheme so
 * historical journal entries still resolve to the correct tool class.
 */

import { describe, it, expect } from "vitest";
import { READ_ONLY_TOOL_NAMES, isWriteToolName } from "../../../src/journal/patterns/tool-classes.js";

describe("tool-classes: underscore (6.0.0+) names", () => {
  const readOnly = [
    "admin_get_profile", "admin_overview", "admin_refresh_session_context",
    "calendar_entities_list", "calendar_events_conflicts", "calendar_events_list", "calendar_export_ics",
    "files_describe", "files_diff_against_disk", "files_find_related",
    "files_get_diff", "files_get_history", "files_list",
    "files_read", "files_read_outline", "files_regex_search", "files_search",
    "folders_list",
    "hands_list",
    "journal_status",
    "projects_list", "projects_map",
    "resources_export_report", "resources_list_reports",
    "tags_list", "tags_suggest",
  ];
  const writes = [
    "admin_commit_backup", "admin_onboard_agent", "admin_transfer_agent_context",
    "calendar_entities_add", "calendar_entities_delete", "calendar_entities_link", "calendar_entities_update",
    "calendar_events_add", "calendar_events_delete", "calendar_events_update",
    "files_create", "files_delete", "files_move",
    "files_restore", "files_update",
    "folders_create", "folders_delete",
    "hands_confirm", "hands_reload",
    "journal_commit_upgrades", "journal_distill", "journal_housekeep", "journal_write",
    "projects_refresh_index", "projects_register",
    "resources_add_report", "resources_clip_url", "resources_delete_report",
    "tags_add", "tags_remove", "tags_search", "tags_set_favorite",
  ];

  for (const name of readOnly) {
    it(`classifies ${name} as read-only`, () => {
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(true);
      expect(isWriteToolName(name)).toBe(false);
    });
  }

  for (const name of writes) {
    it(`classifies ${name} as write`, () => {
      expect(isWriteToolName(name)).toBe(true);
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false);
    });
  }
});

describe("tool-classes: dotted (5.0.0-5.x) names still classify", () => {
  const readOnly = [
    "admin.get_profile", "admin.overview", "admin.refresh_session_context",
    "calendar.entities.list", "calendar.events.conflicts", "calendar.events.list", "calendar.export_ics",
    "files.describe", "files.diff_against_disk", "files.find_related",
    "files.get_diff", "files.get_history", "files.list",
    "files.read", "files.read_outline", "files.regex_search", "files.search",
    "folders.list",
    "hands.list",
    "journal.status",
    "projects.list", "projects.map",
    "resources.export_report", "resources.list_reports",
    "tags.list", "tags.suggest",
  ];
  const writes = [
    "admin.commit_backup", "admin.onboard_agent", "admin.transfer_agent_context",
    "calendar.entities.add", "calendar.entities.delete", "calendar.entities.link", "calendar.entities.update",
    "calendar.events.add", "calendar.events.delete", "calendar.events.update",
    "files.create", "files.delete", "files.move",
    "files.restore", "files.update",
    "folders.create", "folders.delete",
    "hands.confirm", "hands.reload",
    "journal.commit_upgrades", "journal.distill", "journal.housekeep", "journal.write",
    "projects.refresh_index", "projects.register",
    "resources.add_report", "resources.clip_url", "resources.delete_report",
    "tags.add", "tags.remove", "tags.search", "tags.set_favorite",
  ];

  for (const name of readOnly) {
    it(`classifies ${name} as read-only`, () => {
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(true);
      expect(isWriteToolName(name)).toBe(false);
    });
  }

  for (const name of writes) {
    it(`classifies ${name} as write`, () => {
      expect(isWriteToolName(name)).toBe(true);
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false);
    });
  }
});

describe("tool-classes: pre-5.0.0 dotted names still classify", () => {
  it("classifies 4.7.x read names as read-only", () => {
    for (const name of ["admin.stats", "admin.whats_new", "files.bundle_search", "files.grep", "files.read_by_path", "files.read_lines", "files.read_many", "files.read_section", "hands.describe_schema"]) {
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("classifies 4.7.x write names as write", () => {
    for (const name of ["files.create_many", "files.delete_many", "files.update_section", "journal.append", "journal.intent", "journal.note"]) {
      expect(isWriteToolName(name)).toBe(true);
    }
  });

  it("classifies pre-4.7.1 legacy names", () => {
    expect(READ_ONLY_TOOL_NAMES.has("read_file")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("search")).toBe(true);
    expect(isWriteToolName("create_file")).toBe(true);
    expect(isWriteToolName("move_file")).toBe(true);
  });
});
