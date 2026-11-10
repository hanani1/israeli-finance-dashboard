import { loadEnvFile } from 'node:process';
import { categorizeUnassignedTransactions } from '@/lib/services/llmCategorizationService';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

async function main(): Promise<void> {
  const categorized = await categorizeUnassignedTransactions();
  console.log(`[categorization] Assigned ${categorized} transaction(s) with Kiro.`);
}

void main().catch((error) => {
  console.error('[categorization] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
