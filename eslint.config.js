import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import eslintConfigPrettier from "eslint-config-prettier";
import barrelFiles from "eslint-plugin-barrel-files";
import checkFile from "eslint-plugin-check-file";
import commentRules from "eslint-plugin-comment-rules";
import importX from "eslint-plugin-import-x";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

export default tseslint.config(
	includeIgnoreFile(fileURLToPath(new URL(".gitignore", import.meta.url))),

	{
		ignores: [
			"**/*.config.js",
			"**/*.config.ts",
			"**/vite.config.*",
			"**/tailwind.config.*",
			"**/postcss.config.*",
			"**/*.test.ts",
			"**/*.test.tsx",
			"**/__fixtures__/**",
		],
	},

	js.configs.recommended,

	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.stylisticTypeChecked,

	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},

	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				...globals.es2022,
			},
		},
		plugins: {
			react,
			"react-hooks": reactHooks,
			"jsx-a11y": jsxA11y,
			"import-x": importX,
			"barrel-files": barrelFiles,
			"check-file": checkFile,
			"@stylistic": stylistic,
			"comment-rules": commentRules,
		},
		settings: {
			react: {
				version: "detect",
			},
			"import-x/resolver": {
				typescript: { alwaysTryTypes: true },
			},
		},
		rules: {
			"prefer-arrow-callback": "error",
			"arrow-body-style": ["error", "as-needed"],

			"comment-rules/no-restricted-comments": ["error", "docs"],

			"@typescript-eslint/naming-convention": [
				"error",
				{
					selector: "default",
					format: ["camelCase"],
					leadingUnderscore: "allow",
				},
				{
					selector: "variable",
					format: ["camelCase", "PascalCase", "UPPER_CASE"],
					leadingUnderscore: "allow",
					custom: {
						regex: "^(_|[xyz]|.{2,})$",
						match: true,
					},
				},
				{
					selector: "parameter",
					format: ["camelCase", "PascalCase"],
					leadingUnderscore: "allowSingleOrDouble",
					filter: {
						regex: "^_+$",
						match: false,
					},
					custom: {
						regex: "^([xyz]|.{2,})$",
						match: true,
					},
				},
				{
					selector: "function",
					format: ["camelCase", "PascalCase"],
				},
				{
					selector: "typeParameter",
					format: ["PascalCase"],
					custom: { regex: "^[A-Z]([a-zA-Z0-9]*)?$", match: true },
				},
				{
					selector: "interface",
					format: ["PascalCase"],
				},
				{
					selector: "typeAlias",
					format: ["PascalCase"],
				},
				{
					selector: "class",
					format: ["PascalCase"],
				},
				{
					selector: "enum",
					format: ["PascalCase"],
				},
				{
					selector: "enumMember",
					format: ["PascalCase", "UPPER_CASE"],
				},
				{
					selector: "property",
					format: ["camelCase", "PascalCase", "UPPER_CASE"],
					leadingUnderscore: "allow",
				},
				{
					selector: "objectLiteralProperty",
					format: null,
				},
				{
					selector: "typeProperty",
					format: null,
				},
				{
					selector: "import",
					format: null,
				},
			],

			"@typescript-eslint/consistent-type-definitions": ["error", "interface"],
			"@typescript-eslint/array-type": ["error", { default: "generic" }],
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",
			"@typescript-eslint/prefer-nullish-coalescing": "error",
			"@typescript-eslint/promise-function-async": "off",
			"@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
			"@typescript-eslint/await-thenable": "error",
			"@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],

			"@typescript-eslint/consistent-type-imports": [
				"error",
				{
					prefer: "type-imports",
					fixStyle: "inline-type-imports",
				},
			],
			"@typescript-eslint/no-import-type-side-effects": "error",

			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
			"@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
			"no-console": ["warn", { allow: ["warn", "error"] }],
			"prefer-const": "error",
			"no-var": "error",
			eqeqeq: ["error", "always"],

			"id-denylist": [
				"error",
				"arr",
				"btn",
				"buf",
				"cb",
				"cfg",
				"ch",
				"ctor",
				"ctx",
				"curr",
				"dst",
				"el",
				"elem",
				"err",
				"evt",
				"fn",
				"impl",
				"idx",
				"len",
				"lhs",
				"msg",
				"num",
				"obj",
				"opts",
				"params",
				"pkg",
				"prev",
				"ptr",
				"req",
				"res",
				"ret",
				"rhs",
				"src",
				"str",
				"temp",
				"tmp",
				"val",
				"var",
			],

			"import-x/extensions": ["error", "never", { pattern: { css: "always" }, ignorePackages: true }],
			"import-x/no-useless-path-segments": ["error", { noUselessIndex: true }],
			"import-x/no-cycle": "error",
			"import-x/order": [
				"error",
				{
					groups: ["builtin", "external", "internal", "parent", "sibling", "index", "object", "type"],
					"newlines-between": "never",
					alphabetize: { order: "asc", caseInsensitive: true },
				},
			],

			"check-file/filename-blocklist": [
				"error",
				{ "**/types.ts": "*.types.ts" },
				{
					errorMessage: "'{{ target }}' is blocked: colocate types with the module that owns them",
				},
			],
			"check-file/folder-naming-convention": [
				"error",
				{
					"src/**/": "KEBAB_CASE",
					"src/**/components/**/": "PASCAL_CASE",
				},
			],

			"barrel-files/avoid-barrel-files": "error",
			"barrel-files/avoid-re-export-all": "error",
			"barrel-files/avoid-namespace-import": "warn",

			...reactHooks.configs.recommended.rules,
			...jsxA11y.flatConfigs.recommended.rules,
			"react/jsx-no-target-blank": "error",
			"react/jsx-curly-brace-presence": ["error", { props: "never", children: "never" }],

			"@typescript-eslint/no-unnecessary-type-parameters": "off",
			"@typescript-eslint/no-non-null-assertion": "warn",
			"@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
			"@typescript-eslint/unbound-method": "off",
			"@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
			"@typescript-eslint/no-empty-object-type": "off",
			"@typescript-eslint/no-namespace": "off",
			"@typescript-eslint/consistent-indexed-object-style": "off",
			"@typescript-eslint/no-unsafe-function-type": "off",
			"@typescript-eslint/prefer-for-of": "off",
			"react-hooks/exhaustive-deps": "off",

			"@stylistic/padding-line-between-statements": [
				"error",
				{ blankLine: "always", prev: "*", next: "*" },
				{ blankLine: "any", prev: "expression", next: "expression" },
				{
					blankLine: "any",
					prev: ["const", "let", "var"],
					next: ["const", "let", "var"],
				},
				{ blankLine: "any", prev: "import", next: "import" },
				{ blankLine: "any", prev: "export", next: "export" },
				{ blankLine: "any", prev: "interface", next: "interface" },
				{ blankLine: "any", prev: "type", next: "type" },
				{ blankLine: "any", prev: ["case", "default"], next: ["case", "default"] },
			],
		},
	},

	{
		files: ["**/src/index.ts", "**/src/index.tsx", "**/src/react/index.ts"],
		rules: {
			"barrel-files/avoid-barrel-files": "off",
			"barrel-files/avoid-re-export-all": "off",
		},
	},

	{
		files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
		...tseslint.configs.disableTypeChecked,
		rules: {
			...tseslint.configs.disableTypeChecked.rules,
			"prefer-arrow-callback": "error",
			"prefer-const": "error",
			"no-var": "error",
		},
	},

	{
		files: ["**/main/**/*.ts"],
		rules: {
			"no-console": "off",
		},
	},

	{
		files: ["**/components/ui/**/*.tsx"],
		rules: {
			"arrow-body-style": "off",
			"barrel-files/avoid-namespace-import": "off",
			"barrel-files/avoid-re-export-all": "off",
		},
	},

	eslintConfigPrettier,
);
