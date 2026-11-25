import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    // Generated/vendored trees and operator-only tooling. The intranet package
    // never ships the VM scripts; linting them against browser/ESM rules only
    // produced noise.
    ignores: [
      ".next/**",
      "build/**",
      "dist/**",
      "demo/**",
      "public/monaco/**",
      "tmp-*.cjs",
      "scripts/vm/**",
      "scripts/vm*.cjs",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    // CommonJS entry points (Electron main/preload, packaged installers) are
    // intentionally require()-based; the ESM rule does not apply to them.
    files: ["**/*.cjs", "electron/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
