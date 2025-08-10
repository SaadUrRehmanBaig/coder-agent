import * as vscode from 'vscode';
import { checkOllamaRunning } from './utils';
import { generateEmbeddings, watchForFileChanges } from './embedding';
import { registerAutocomplete } from './autocomplete';

export async function activate(context: vscode.ExtensionContext) {

	const isOllamaRunning = await checkOllamaRunning();

	if (!isOllamaRunning) {
		vscode.window.showErrorMessage("Ollama is not running. Please start the Ollama server");
		return;
	}

	// autocompletion
	registerAutocomplete(context);

	// Run on startup if workspace is open
	if (vscode.workspace.workspaceFolders?.length) {
		generateEmbeddings();
		watchForFileChanges();
	}

	// Run when the user triggers the command
	const disposable = vscode.commands.registerCommand(
		'codeAgent.generateEmbeddings',
		generateEmbeddings
	);

  context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
