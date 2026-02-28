const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeProfiles,
  nextProfile,
  isEveryProfileExhausted,
} = require("../lib/failover");

test("normalizeProfiles returns default profile when input is empty", () => {
  const profiles = normalizeProfiles(null);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, "primary");
  assert.equal(profiles[0].enabled, true);
});

test("normalizeProfiles sorts by priority descending", () => {
  const profiles = normalizeProfiles([
    { id: "b", priority: 10, enabled: true },
    { id: "a", priority: 200, enabled: true },
  ]);
  assert.equal(profiles[0].id, "a");
  assert.equal(profiles[1].id, "b");
});

test("nextProfile rotates through enabled profiles", () => {
  const profiles = normalizeProfiles([
    { id: "p1", priority: 100, enabled: true },
    { id: "p2", priority: 90, enabled: true },
    { id: "p3", priority: 80, enabled: true },
  ]);
  assert.equal(nextProfile(profiles, null).id, "p1");
  assert.equal(nextProfile(profiles, "p1").id, "p2");
  assert.equal(nextProfile(profiles, "p2").id, "p3");
  assert.equal(nextProfile(profiles, "p3").id, "p1");
});

test("nextProfile skips disabled profiles", () => {
  const profiles = normalizeProfiles([
    { id: "p1", priority: 100, enabled: true },
    { id: "p2", priority: 90, enabled: false },
    { id: "p3", priority: 80, enabled: true },
  ]);
  assert.equal(nextProfile(profiles, "p1").id, "p3");
});

test("isEveryProfileExhausted detects all enabled attempts used", () => {
  const profiles = normalizeProfiles([
    { id: "p1", priority: 100, enabled: true },
    { id: "p2", priority: 90, enabled: false },
    { id: "p3", priority: 80, enabled: true },
  ]);
  assert.equal(isEveryProfileExhausted(profiles, ["p1"]), false);
  assert.equal(isEveryProfileExhausted(profiles, ["p1", "p3"]), true);
});
