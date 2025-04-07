// Ensure we use Windows Git when possibly running under Cygwin
const {TYPEDOC_GIT_DIR, PATH, OS} = process.env;
if (OS==="Windows_NT" && TYPEDOC_GIT_DIR !== undefined) process.env.PATH=`${TYPEDOC_GIT_DIR};${PATH}`;

/** @type {import('typedoc').TypeDocOptions} */
module.exports = {
    entryPoints: [
        "./src/mod.ts",
        "./src/ext.ts",
        "./src/shared.ts",
        "./src/signals.ts",
        "./src/utils.ts",
    ],
    name: "Uneventful",
    router: "structure",
    customCss: ["./typedoc/custom.css"],
    customJs: ["./typedoc/custom.js"],
    categorizeByGroup: false,
    categoryOrder: [
        "Jobs",
        "Reactive Values",
        "Reactive Behaviors",
        "Resource Management",
        "Scheduling",
        "Signals",
        "Stream Consumers",
        "Stream Producers",
        "Stream Operators",
        "Requests and Results",
        "*",
        "Errors",
        "Other",
    ],
    hideGenerator: true,
    excludeInternal: true,
    excludePrivate: true,
    excludeProtected: true,
    excludeReferences: true,
    useFirstParagraphOfCommentAsSummary: true,
    navigation: {
        includeCategories: true,
        includeFolders: false,
    },
    navigationLinks: {
        Github: "https://github.com/pjeby/uneventful/"
    },
    projectDocuments: ["CHANGELOG.md"],
    sort: [
        "alphabetical"
    ],
    sortEntryPoints: false
};

// Set source links to vscode unless running on GitHub Actions
const {CI, GITHUB_RUN_ID} = process.env;
if (CI === undefined || GITHUB_RUN_ID === undefined) {
    module.exports.sourceLinkTemplate = `vscode://file/${__dirname}/{path}:{line}`;
}
