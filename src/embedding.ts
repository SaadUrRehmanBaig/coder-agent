import * as vscode from 'vscode';
import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import ollama from 'ollama';

const DB_PATH = `${process.env.HOME || process.env.USERPROFILE}/.local_code_embeddings`;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const SUPPORTED_EXTENSIONS = /\.(ts|js|py|php|vue)$/;

let embeddingInProgress = false;

async function getSplitter() {
  const { RecursiveCharacterTextSplitter } = await import('langchain/text_splitter');
  return new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });
}

async function openOrCreateTable(db: any, projectName: string) {
  let table;
  try {
    table = await db.openTable(projectName);
  } catch {
    // Get the embedding dimensions first by creating a dummy embedding
    const dummyEmbedding = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: 'dummy text',
    });
    const dims = dummyEmbedding.embedding.length;
    
    // Create table with proper schema
    table = await db.createTable(projectName, [
      { 
        id: 'dummy', 
        file: 'dummy', 
        mtime: 0, 
        text: 'dummy', 
        embedding: Array(dims).fill(0),
      }
    ]);
    await table.delete(`id = 'dummy'`);
  }
  return table;
}

async function embedChunks(chunks: string[]) {
  const embeddings: number[][] = [];
  for (const chunk of chunks) {
    const res = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: chunk,
    });
    embeddings.push(res.embedding);
  }
  return embeddings;
}

export async function generateEmbeddings() {
  if (embeddingInProgress) {
    vscode.window.showWarningMessage('Embedding already in progress. Please wait until it finishes.');
    return;
  }
  embeddingInProgress = true;

  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    const db = await lancedb.connect(DB_PATH);
    const splitter = await getSplitter();
    const excludePatterns = '**/{node_modules,.git,dist,build,coverage,out}/**';

    let totalFiles = 0;
    // Count total files in all workspace folders
    for (const folder of workspaceFolders) {
      const files = await vscode.workspace.findFiles('**/*.{ts,js,py,php,vue}', excludePatterns);
      totalFiles += files.length;
    }

    let processedFiles = 0;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Generating local code embeddings...',
        cancellable: false,
      },
      async (progress) => {
        for (const folder of workspaceFolders) {
          const projectName = path.basename(folder.uri.fsPath).replace(/[^a-zA-Z0-9_-]/g, '_');
          const table = await openOrCreateTable(db, projectName);

          const files = await vscode.workspace.findFiles('**/*.{ts,js,py,php,vue}', excludePatterns);

          for (const file of files) {
            processedFiles++;
            progress.report({
              message: `${path.basename(file.fsPath)} (${processedFiles}/${totalFiles})`,
              increment: (1 / totalFiles) * 100,
            });

            const stat = await vscode.workspace.fs.stat(file);
            const lastModified = stat.mtime;

            const existing = await table.query()
              .filter(`file = '${file.fsPath}' AND mtime = ${lastModified}`)
              .toArray();
            if (existing.length > 0) continue;

            const document = await vscode.workspace.fs.readFile(file);
            const text = document.toString().trim();
            if (!text) continue;

            const chunks = await splitter.splitText(text);
            const chunkEmbeddings = await embedChunks(chunks);

            const rows = chunks.map((chunk, i) => ({
              id: `${file.fsPath}-${i}`,
              file: file.fsPath,
              mtime: lastModified,
              text: chunk,
              embedding: chunkEmbeddings[i],
            }));

            if (rows.length > 0) {
              await table.add(rows);
            }
          }

          vscode.window.showInformationMessage(
            `Local embeddings complete for project: ${projectName} (LanceDB).`
          );
        }
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Embedding failed: ${err}`);
  } finally {
    embeddingInProgress = false;
  }
}

export async function watchForFileChanges() {
  const splitter = await getSplitter();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,js,py,php,vue}');

  watcher.onDidChange(async (uri) => {
    const filePath = uri.fsPath;
    if (!SUPPORTED_EXTENSIONS.test(filePath)) return;

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) return;

      const db = await lancedb.connect(DB_PATH);

      const folder = workspaceFolders.find(f => filePath.startsWith(f.uri.fsPath));
      if (!folder) return;

      const projectName = path.basename(folder.uri.fsPath).replace(/[^a-zA-Z0-9_-]/g, '_');

      const table = await openOrCreateTable(db, projectName);

      const stat = await vscode.workspace.fs.stat(uri);
      const lastModified = stat.mtime;

      // Remove old embeddings for this file
      await table.delete(`file = '${filePath}'`);

      // Read file content
      const fileData = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(fileData).toString('utf8').trim();
      if (!text) return;

      const chunks = await splitter.splitText(text);
      const chunkEmbeddings = await embedChunks(chunks);

      const rows = chunks.map((chunk, i) => ({
        id: `${filePath}-${i}`,
        file: filePath,
        mtime: lastModified,
        text: chunk,
        embedding: chunkEmbeddings[i],
      }));

      if (rows.length > 0) {
        await table.add(rows);
        vscode.window.setStatusBarMessage(`Re-embedded: ${path.basename(filePath)}`, 3000);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Re-embedding failed for ${filePath}: ${err}`);
    }
  });
}
