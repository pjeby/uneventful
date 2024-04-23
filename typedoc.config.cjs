// Ensure we use Windows Git when possibly running under Cygwin
const {TYPEDOC_GIT_DIR, PATH, OS} = process.env;
if (OS==="Windows_NT" && TYPEDOC_GIT_DIR !== undefined) process.env.PATH=`${TYPEDOC_GIT_DIR};${PATH}`;

/** @type {import('typedoc').TypeDocOptions} */
module.exports = {
    entryPoints: ["./src/mod.ts"],
    customCss: ["./typedoc/custom.css"],
    categorizeByGroup: false,
    categoryOrder: [
        "Jobs",
        "Resource Management",
        "Scheduling",
        "Requests and Results",
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
