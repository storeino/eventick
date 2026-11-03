import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * A deliberately small lint config, for one class of bug.
 *
 * A `<VenuePlan />` used without importing it shipped to the browser and
 * crashed the event page with "VenuePlan is not defined". Nothing caught it:
 * these are .jsx files so `tsc` never type-checks them, and the page is
 * client-rendered (`ssr: false`), so `next build` compiles the component
 * without ever executing it. An undefined identifier sails straight through
 * a green build.
 *
 * So this is not a style config — there are no formatting rules here, and it
 * is not trying to become one. It answers a single question that the build
 * cannot: does every name used in a file actually exist?
 */
export default [
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // react-hooks is registered because the codebase already carries
    // inline `eslint-disable react-hooks/exhaustive-deps` comments; an
    // unregistered rule name is itself an error, so leaving it out made
    // six files fail over disable comments for a rule nobody ran.
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      // The rule this config exists for. react/jsx-no-undef, NOT core
      // no-undef: core ESLint treats a JSX element name as opaque, so
      // <TotallyUndefinedThing /> passes no-undef cleanly. Verified both
      // ways before trusting it.
      "react/jsx-no-undef": "error",
      // Still on, for undefined identifiers outside JSX.
      "no-undef": "error",
      // JSX counts as a use: without this, `import { VenuePlan }` followed by
      // only `<VenuePlan />` reads as an unused import.
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      // An import that is never used is usually a leftover from a move, and
      // was how the dead `Plus` icon survived an earlier edit. Warn rather
      // than error: it is untidy, not broken.
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      // The dependency rule those comments are suppressing. Warn, not
      // error: the existing suppressions were deliberate and explained.
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
