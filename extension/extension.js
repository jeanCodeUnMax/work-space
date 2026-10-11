// DEV entry point for everything-search-dev.
// Spawns the MCP server lazily at activation and wires the sidebar webview.
'use strict';

const vscode = require('vscode');
const { McpClient } = require('./src/mcpClient');
const { SearchViewProvider } = require('./src/searchView');

/** @type {McpClient | undefined} */
let client;
/** @type {vscode.OutputChannel | undefined} */
let output;

function activate(context) {
  output = vscode.window.createOutputChannel('everything-search');
  client = new McpClient(output);

  const provider = new SearchViewProvider(context, client, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(
      SearchViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('everything-search.openSearch', () => {
      provider.reveal();
    }),
    { dispose: () => client && client.dispose() }
  );

  // Warm up the python server in the background so the first query is fast.
  client.warmup();
}

function deactivate() {
  if (client) {
    client.dispose();
    client = undefined;
  }
}

module.exports = { activate, deactivate };
