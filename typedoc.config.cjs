/** @type {import('typedoc').TypeDocOptions} */
module.exports = {
    entryPoints: ["./src/mod.ts"],
    out: "docs/ref",
    categorizeByGroup: false,
    categoryOrder: [
        "Flows",
        "Signals",
        "Resource Management",
        "Stream Producers",
        "Stream Operators",
        "Stream Consumers",
        "*",
        "Errors",
        "Other",
    ],
    hideGenerator: true,
    excludeInternal: true,
    hideParameterTypesInTitle: false,
    navigation: {
        includeCategories: true,
    },
    sort: [
        "alphabetical"
    ],
};