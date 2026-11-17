# 4D for Zed

One extension, nothing else to install:

- **Syntax highlighting, brackets, indent, outline** for `.4dm` (tree-sitter grammar in `grammar.js`).
- **Language server** (completion, hover, go to definition, signature help, diagnostics, semantic tokens)
  powered by 4D's own `tool4d`.

On first use the extension downloads tool4d (about 25 MB) from 4D's servers into its own folder, using Zed's
bundled Node.js. It needs no system tools (`ar`, `tar`, `curl`, `apt`, …) on Linux, and on Linux it carries
the shared libraries tool4d needs (libc++, libc++abi, libunwind, libfreeimage stub), using them only when the system
lacks its own. Open a folder that contains a 4D project (`Project/*.4DProject`).

## Optional settings (`settings.json`)
```jsonc
"lsp": {
  "4d-analyzer": {
    "binary": { "path": "/path/to/tool4d" },                         // skip download, use this
    "settings": { "version": "latest", "channel": "stable", "download": true }
  }
},
"languages": { "4D": { "semantic_tokens": "combined" } }
```
`version`: `latest`, `21`, `21R`, `21R3`. A tool4d already on `PATH`, in `/opt/tool4d`, `/Applications/tool4d.app`, or
downloaded by the VS Code 4D-Analyzer extension is reused automatically.

## Layout
`languages/4d` queries · `src/lib.rs` Zed extension · `bridge/bridge.js` stdio↔TCP bridge + tool4d installer ·
`compat/` Linux library shims (LLVM libc++/libc++abi/libunwind from Ubuntu 24.04, Apache-2.0 WITH LLVM-exception,
licences in `compat/licenses`; `libfreeimage-stub.c` is the source of the stub).

## Developing the grammar
`grammar.js` and the generated `src/parser.c` sit at the repo root; Zed builds the grammar from this repository
at the commit pinned in `extension.toml`. After editing `grammar.js`: `npm install && npx tree-sitter generate && npx tree-sitter test`,
commit and push, then update `rev` in `extension.toml` to the pushed commit.
