export async function checkOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:11434/api/tags', { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}