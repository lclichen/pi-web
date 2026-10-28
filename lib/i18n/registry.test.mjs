import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getLocalePlugin, getSupportedLocales, resolveBrowserLocale } = await jiti.import("./registry.ts");

test("uses the first supported browser language and falls back to English", () => {
  assert.equal(resolveBrowserLocale(["zh-CN", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hans", "zh-TW"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hans-HK", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-SG", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-MY", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-TW", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["ZH-tW", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-Hant", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-Hant-HK", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-HK", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["zh-MO", "en-US"]), "zh-TW");
  assert.equal(resolveBrowserLocale(["en-US", "zh-CN"]), "en");
  assert.equal(resolveBrowserLocale(["fr-FR", "zh-CN"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["fr-FR"]), "en");
  assert.equal(resolveBrowserLocale([]), "en");
});

test("returns only registered locales", () => {
  assert.deepEqual(getSupportedLocales(), ["en", "zh-CN", "zh-TW"]);
  assert.equal(getLocalePlugin("en").id, "en");
  assert.equal(getLocalePlugin("zh-TW")?.label, "繁體中文");
  assert.equal(getLocalePlugin("zh-TW")?.messages["common.language"], "語言");
  assert.equal(getLocalePlugin("missing"), undefined);
});

test("built-in locale packages share one sorted key order (line-aligned diffs)", () => {
  const localeIds = getSupportedLocales();
  const canonical = Object.keys(getLocalePlugin(localeIds[0]).messages);
  // Insertion order must be bytewise-sorted so the files line-align in diffs
  // and a missing key reads as a plain gap. Object.keys preserves insertion
  // order for these string (non-numeric) keys.
  const sorted = [...canonical].every((key, index) => index === 0 || canonical[index - 1] <= key);
  assert.ok(sorted, `${localeIds[0]} keys must be sorted — run scripts/i18n-normalize.mjs`);
  for (const id of localeIds.slice(1)) {
    assert.deepEqual(
      Object.keys(getLocalePlugin(id).messages),
      canonical,
      `${id} must share the ${localeIds[0]} key order — run scripts/i18n-normalize.mjs`,
    );
  }
});

test("built-in locale packages have the complete English key and required placeholder sets", () => {
  const englishMessages = getLocalePlugin("en").messages;
  const englishKeys = Object.keys(englishMessages).sort();
  const placeholders = (message) => [...message.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();
  const optionalPlaceholders = { "files.conflictSummary": ["countSuffix"] };

  for (const locale of getSupportedLocales().filter((id) => id !== "en")) {
    const messages = getLocalePlugin(locale).messages;
    assert.deepEqual(Object.keys(messages).sort(), englishKeys, `${locale} keys must match English`);
    for (const key of englishKeys) {
      const optional = optionalPlaceholders[key] ?? [];
      const required = placeholders(englishMessages[key]).filter((name) => !optional.includes(name));
      const translated = placeholders(messages[key]).filter((name) => !optional.includes(name));
      assert.deepEqual(translated, required, `${locale}.${key} placeholders must match English`);
    }
  }
});
