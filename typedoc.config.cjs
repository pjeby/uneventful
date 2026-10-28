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
        "Tasks and Context",
        "Resource Management",
        "Dependency Tracking",
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
    externalSymbolLinkMappings: {
        "typescript": {
            "Promise": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise"
        }
    },
    plugin: [noInheritedMembersInPreviews, stripTitlePrefixes],
    projectDocuments: ["CHANGELOG.md"],
    sort: [
        "alphabetical"
    ],
    /** @param {import('markdown-it').default} parser */
    markdownItLoader(parser) {
        parser.use(require('markdown-it-footnote'))
        // Use footnote tag to generate the anchor ID - lets you dedupe between sections
        parser.renderer.rules.footnote_anchor_name = (tokens, idx) => tokens[idx].meta.label
    },
    sortEntryPoints: false
};

// Set source links to vscode unless running on GitHub Actions
const {CI, GITHUB_RUN_ID} = process.env;
if (CI === undefined || GITHUB_RUN_ID === undefined) {
    module.exports.sourceLinkTemplate = `vscode://file/${__dirname}/{path}:{line}`;
}

async function noInheritedMembersInPreviews() {
    const path = require("node:path")
    const { pathToFileURL } = require("node:url")
    const typedocDir = path.dirname(require.resolve("typedoc/package.json"))
    const [{ DefaultTheme, JSX }, { around }, { FormattedCodeBuilder }] =
    await Promise.all([
        import("typedoc"),
        import("monkey-around"),
        import(pathToFileURL(path.join(typedocDir, "dist/lib/output/formatter.js")).href),
    ])

    around(DefaultTheme.prototype, {
        getRenderContext(old) {
            return function (page) {
                const ctx = old.call(this, page)
                const {reflectionPreview} = ctx
                ctx.reflectionPreview = (props) => {
                    const restore = around(FormattedCodeBuilder.prototype, {
                        interface(old) {
                            return function (item) {
                                const result = old.call(this, item); // { type: "nodes", content: [6 entries] }
                                const types = item.extendedTypes;
                                if (types?.length && result.content.length === 6) {
                                    // content: [0]"interface" [1]sp [2]name [3]typeParams [4]sp [5]body-group
                                    result.content.splice(5, 0, ...[
                                        keyword("extends"),
                                        space(),
                                        ...types.flatMap((t, i) =>
                                            i === 0
                                                ? [this.type(t, "none")]
                                                : [symbol(","), space(), this.type(t, "none")],
                                        ),
                                        space(), // trailing space before the "{"
                                    ]);
                                } else if (types?.length) {
                                    // layout drifted in some future typedoc — skip rather than mangle
                                    console.warn("compact-interface: unexpected interface() node layout");
                                }
                                return result;
                            };
                        },
                        member(old) {
                            return function (members, item, options) {
                                // The converter copies base members in via getPropertiesOfType() and
                                // ImplementsPlugin flags exactly those with ReflectionFlag.Inherited.
                                // Members redeclared in the child (overrides) get `overwrites` instead,
                                // so this skips purely-inherited members only.
                                if (item.flags.isInherited) return;
                                return old.call(this, members, item, options);
                            };
                        },
                    })
                    try { return reflectionPreview(props) } finally { restore() }
                }
                return ctx
            }
        }
    })

    function keyword(text) { return {
        type: "element",
        content: JSX.createElement("span", { class: "tsd-signature-keyword" }, text),
        length: text.length,
    }}

    function symbol(text) { return {
        type: "element",
        content: JSX.createElement("span", { class: "tsd-signature-symbol" }, text),
        length: text.length,
    }}

    function space() { return { type: "text", content: " " } }
}

async function stripTitlePrefixes() {
    const [{ DefaultTheme, ReflectionKind, ReflectionFlag }, { around }] = await Promise.all([
        import("typedoc"), import("monkey-around"),
    ])
    around(DefaultTheme.prototype, {
        getRenderContext(old) {
            return function (page) {
                const ctx = old.call(this, page)
                const {header} = ctx
                ctx.header = (props) => {
                    const {model} = props
                    if (model.isDocument() || model.isProject()) {
                        // || model.kind !== ReflectionKind.Variable ??
                        return header(props)
                    }
                    // Force non-const rendering
                    model.flags.setSingleFlag(ReflectionFlag.Const, false)
                    const restore = around(ReflectionKind, {
                        singularString(){ return function() {
                            restore()
                            return ""
                        }},
                    });
                    try { return header(props) } finally { restore() }
                }
                return ctx
            }
        }
    })
}
