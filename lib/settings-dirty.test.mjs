import assert from "node:assert/strict";
import test from "node:test";
import { isAnySettingsDirty, registerSettingsDirty } from "./settings-dirty.ts";

test("reports dirty only while a registered predicate returns true", () => {
  let dirty = false;
  const unregister = registerSettingsDirty("quick-templates", () => dirty);
  assert.equal(isAnySettingsDirty(), false);
  dirty = true;
  assert.equal(isAnySettingsDirty(), true);
  unregister();
  assert.equal(isAnySettingsDirty(), false);
});

test("re-registering a section replaces its predicate; stale unregister is a no-op", () => {
  const first = registerSettingsDirty("quick-templates", () => true);
  const second = registerSettingsDirty("quick-templates", () => false);
  assert.equal(isAnySettingsDirty(), false);
  first(); // stale cleanup must not evict the replacement
  assert.equal(isAnySettingsDirty(), false);
  second();
  assert.equal(isAnySettingsDirty(), false);
});
