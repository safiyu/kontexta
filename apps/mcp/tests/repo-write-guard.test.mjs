import { test } from "node:test";
import assert from "node:assert/strict";
import { refuseProjectDestination, refuseRepoFile, refuseProjectFolder } from "../dist/repo-write-guard.js";

test("files.create: 'project' is refused, knowledge and kontexta are allowed", () => {
  assert.match(refuseProjectDestination("project"), /knowledge base/i);
  assert.equal(refuseProjectDestination("knowledge"), null);
  assert.equal(refuseProjectDestination("kontexta"), null);
});

test("refusal tells the agent where to write instead", () => {
  assert.match(refuseProjectDestination("project"), /destination 'knowledge'/);
});

test("repo files (reference storage in a project) cannot be rewritten or moved; KB and kontexta files can", () => {
  assert.match(refuseRepoFile({ storage_type: "reference", project_id: 3 }), /project repo/i);
  assert.equal(refuseRepoFile({ storage_type: "local", project_id: null }), null);
  assert.equal(refuseRepoFile({ storage_type: "local", project_id: 3 }), null);
});

test("folders.create under a project repo is refused; the KB (no project) is allowed", () => {
  assert.match(refuseProjectFolder(3), /project repo/i);
  assert.equal(refuseProjectFolder(null), null);
  assert.equal(refuseProjectFolder(undefined), null);
});
