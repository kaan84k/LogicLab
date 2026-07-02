// Flat ESLint config (ESLint 9+/10) using typescript-eslint.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-test/", "node_modules/"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // tsc (noUnusedLocals/Parameters) already covers unused vars; keep ESLint
      // focused on correctness smells rather than duplicating that.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
