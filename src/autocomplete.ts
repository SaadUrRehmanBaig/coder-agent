import * as vscode from 'vscode';
import * as lancedb from '@lancedb/lancedb';
import ollama from 'ollama';
import path from 'path';
import { LANGUAGE_IDS } from './language';
import { debounce } from './utils';

const DB_PATH = `${process.env.HOME || process.env.USERPROFILE}/.local_code_embeddings`;
class CodeAgentInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private db: any;
    private debouncedProvide?: (document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken, cb: (items: vscode.InlineCompletionItem[]) => void) => void;
    private lastResult: vscode.InlineCompletionItem[] = [];
    private running = false;

    constructor() {

        // Debounce calls with 300ms delay
        this.debouncedProvide = debounce(async (
            document: vscode.TextDocument,
            position: vscode.Position,
            context: vscode.InlineCompletionContext,
            token: vscode.CancellationToken,
            callback: (items: vscode.InlineCompletionItem[]) => void
        ) => {
            if (this.running) {
                // Guardrail: Skip if a previous request is still running
                callback(this.lastResult);
                return;
            }

            this.running = true;

            if (token.isCancellationRequested) {
                this.running = false;
                callback([]);
                return;
            }

            try {
                if (!this.db) {
                    this.db = await lancedb.connect(DB_PATH);
                }

                const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                if (!workspaceFolder) {
                    this.running = false;
                    callback([]);
                    return;
                }

                const projectName = path.basename(workspaceFolder.uri.fsPath).replace(/[^a-zA-Z0-9_-]/g, '_');
                let table: lancedb.Table;
                try {
                    table = await this.db.openTable(projectName);
                } catch {
                    this.running = false;
                    callback([]);
                    return;
                }

                const contextText = document.getText(new vscode.Range(0, 0, position.line, position.character));

                if (token.isCancellationRequested) {
                    this.running = false;
                    callback([]);
                    return;
                }

                const res = await ollama.embeddings({
                    model: 'nomic-embed-text',
                    prompt: contextText,
                });

                if (token.isCancellationRequested) {
                    this.running = false;
                    callback([]);
                    return;
                }

                const results = await table.vectorSearch(res.embedding)
                    .limit(3)
                    .toArray();

                if (results.length === 0) {
                    this.running = false;
                    callback([]);
                    return;
                }

                const relevantCodeChunks = results.map(result => `
                    // From file: ${path.basename(result.file as string)}
                    ${result.text as string}
                    `).join('\n\n');
                
                const completionPrompt = `You are an expert AI code assistant.
                    Use the following relevant code snippets as context to complete the user's code.

                    <context>
                    ${relevantCodeChunks}
                    </context>

                    The user is currently writing in a file. Here is the code they have written so far:
                    <file_content>
                    ${contextText}
                    </file_content>

                    Generate the most logical and helpful completion for the user. Do not include the <file_content> in your response, only provide the code that comes next.

                    Completion:
                `;

                const completionResponse = await ollama.generate({
                    model: 'qwen2.5-coder:latest',
                    prompt: completionPrompt,
                    stream: false,
                    options: {
                        temperature: 0.2,
                        num_ctx: 4096,
                    },
                });

                let generatedText = completionResponse.response;

                const trimmedText = generatedText.trim();
                if (trimmedText.startsWith(contextText)) {
                    generatedText = trimmedText.substring(contextText.length).trim();
                }
                else {
                    generatedText = trimmedText.replace(/^```[a-zA-Z]+\n/,'').replace(/```$/,'');
                }

                if (!generatedText) {
                    this.running = false;
                    callback([]);
                    return;
                }

                const item = new vscode.InlineCompletionItem(completionText);
                this.lastResult = [item];
                this.running = false;
                callback(this.lastResult);
            } catch (err) {
                this.running = false;
                callback([]);
            }
        }, 300);
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[]> {
        if (!vscode.workspace.getConfiguration('codeAgent').get('autocomplete.enabled', true)) {
            return [];
        }

        return new Promise((resolve) => {
            this.debouncedProvide!(document, position, context, token, resolve);
        });
    }
}

export function registerAutocomplete(context: vscode.ExtensionContext) {
    const inlineCompletionProvider = new CodeAgentInlineCompletionProvider();

    const disposableInlineCompletion = vscode.languages.registerInlineCompletionItemProvider(
        LANGUAGE_IDS,
        inlineCompletionProvider
    );

    context.subscriptions.push(disposableInlineCompletion);
}