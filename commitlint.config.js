// config-conventional names conventional-changelog-conventionalcommits as its parserPreset, and
// when that module is absent from the pre-commit hook env commitlint falls back to a parser whose
// header pattern has no `!`, so `feat(x)!: y` fails as "type may not be empty". The pattern is
// pinned here so the breaking-change marker parses whatever the hook env resolves.
export default {
	extends: ["@commitlint/config-conventional"],
	parserPreset: {
		parserOpts: {
			headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/,
			headerCorrespondence: ["type", "scope", "subject"],
		},
	},
};
