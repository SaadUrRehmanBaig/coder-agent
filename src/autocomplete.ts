import * as vscode from 'vscode';
import ollama from 'ollama';
import { LANGUAGE_IDS } from './language';
import { debounce } from './utils';

class CodeAgentInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private debouncedProvide?: (document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken, cb: (items: vscode.InlineCompletionItem[]) => void) => void;
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
                callback([]);
                return;
            }

            this.running = true;

            if (token.isCancellationRequested) {
                this.running = false;
                callback([]);
                return;
            }

            try {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                if (!workspaceFolder) {
                    this.running = false;
                    callback([]);
                    return;
                }

                const beforeLines = 30;
                const afterLines = 5;

                // Extract context before the cursor
                const beforeContext = document.getText(
                    new vscode.Range(
                        Math.max(0, position.line - beforeLines), // Up to 30 lines before
                        0,
                        position.line,
                        position.character
                    )
                );

                // Extract context after the cursor
                const afterContext = document.getText(
                    new vscode.Range(
                        position.line,
                        position.character,
                        Math.min(document.lineCount - 1, position.line + afterLines), // Up to 5 lines after
                        document.lineAt(Math.min(document.lineCount - 1, position.line + afterLines)).text.length
                    )
                );

                if (token.isCancellationRequested) {
                    this.running = false;
                    callback([]);
                    return;
                }
                
                const completionPrompt = `You are an expert AI code assistant for autocompletion.

                    The user is currently writing in a file. Here is the code they have written so far, with the cursor position marked as <CURSOR>:
                    <file_content>
                    ${beforeContext}<CURSOR>${afterContext}
                    </file_content>

                    Generate the most logical and helpful completion for the user at the <CURSOR> position. Follow these rules:
                    1. Only provide the new code that comes after the cursor
                    2. Do NOT repeat any code from before or after the cursor
                    3. Do NOT include any explanations or comments
                    4. Do NOT include <file_content> or <CURSOR> in your response
                    5. If no completion is needed, respond with exactly "[NO_COMPLETION]"

                    Completion:
                `;
                const completionResponse = await ollama.generate({
                    model: 'qwen2.5-coder:1.5b-base',
                    prompt: completionPrompt,
                    stream: false,
                    options: {
                        temperature: 0.2,
                    },
                });

                let generatedText = completionResponse.response;

                if (generatedText.trim() === '[NO_COMPLETION]') {
                    this.running = false;
                    callback([]);
                    return;
                }

                let completionSnippet = generatedText.trim()
                    .replace(/^```[a-zA-Z]*\n/, '')
                    .replace(/\n```$/, '')
                    .trim();

                completionSnippet = completionSnippet.split('\n')
                    .filter(line => !line.includes(beforeContext) && !line.includes(afterContext))
                    .join('\n');

                completionSnippet = completionSnippet.replace(/<CURSOR>/g, '');

                const currentLineText = document.lineAt(position.line).text.substring(0, position.character);
                if (completionSnippet.startsWith(currentLineText)) {
                    completionSnippet = completionSnippet.substring(currentLineText.length);
                }

                const finalCompletionText = completionSnippet.trim();
                if (!finalCompletionText) {
                    this.running = false;
                    callback([]);
                    return;
                }

                this.running = false;
                callback([new vscode.InlineCompletionItem(finalCompletionText)]);
            } catch (err) {
                console.error(err);
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