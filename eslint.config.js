// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

export default tseslint.config(
  // Archivos a ignorar
  {
    ignores: ["dist/**", "build/**", "node_modules/**", "coverage/**"],
  },

  // Base JS recomendada
  js.configs.recommended,

  // TypeScript recomendada (type-checked)
  ...tseslint.configs.recommendedTypeChecked,

  // Configuración del proyecto TypeScript (necesaria para type-checked)
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Prettier: desactiva reglas que choquen con el formateador
  prettierConfig,

  // Reglas propias + prettier como regla de lint
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      // Prettier reporta diferencias de formato como errores de lint
      "prettier/prettier": "error",

      // TypeScript
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // General
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
      curly: "error",
    },
  },
);
