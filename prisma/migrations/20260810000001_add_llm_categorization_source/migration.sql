-- Track categories assigned by the configured LLM separately from rules and manual choices.
ALTER TYPE "CategorizationSource" ADD VALUE 'LLM';
