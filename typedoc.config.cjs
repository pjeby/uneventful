/** @type {import('typedoc').TypeDocOptions} */
module.exports = {
    entryPoints: ["./src/mod.ts"],
    out: "docs/ref",
    categorizeByGroup: false,
    categoryOrder: [
        "Flows",
        "Signals",
        "Resource Management",
        "*",
        "Errors",
        "Other",
    ],
    hideGenerator: true,
    navigation: {
        includeCategories: true,
    },
    sort: [
        "alphabetical"
    ],
};