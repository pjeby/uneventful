/** @type {import('typedoc').TypeDocOptions} */
module.exports = {
    entryPoints: ["./src/mod.ts"],
    customCss: ["./typedoc/custom.css"],
    categorizeByGroup: false,
    categoryOrder: [
        "Flows",
        "Resource Management",
        "Jobs and Scheduling",
        "Signals",
        "Stream Consumers",
        "Stream Producers",
        "Stream Operators",
        "*",
        "Errors",
        "Other",
    ],
    hideGenerator: true,
    excludeInternal: true,
    excludePrivate: true,
    excludeProtected: true,
    excludeReferences: true,
    hideParameterTypesInTitle: false,
    navigation: {
        includeCategories: true,
    },
    options: "package.json", // workaround for https://github.com/KnodesCommunity/typedoc-plugins/issues/525
    sort: [
        "alphabetical"
    ],
};
