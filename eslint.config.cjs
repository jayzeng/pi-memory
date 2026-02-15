const js = require("@eslint/js");
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

module.exports = [
	{
		ignores: ["node_modules", "coverage"],
		languageOptions: {
			globals: {
				Buffer: "readonly",
				__dirname: "readonly",
				clearTimeout: "readonly",
				console: "readonly",
				module: "readonly",
				process: "readonly",
				require: "readonly",
				setTimeout: "readonly",
			},
		},
	},
	js.configs.recommended,
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				sourceType: "module",
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			indent: ["error", "tab"],
			quotes: ["error", "double"],
			semi: ["error", "always"],
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
		},
	},
];
