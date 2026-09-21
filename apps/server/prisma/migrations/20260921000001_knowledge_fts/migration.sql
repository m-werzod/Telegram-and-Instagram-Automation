-- Full-text search support for knowledge chunks (keyword fallback when no
-- embedding provider is configured). 'simple' config: language-agnostic
-- tokenization suitable for mixed Uzbek/Russian/English content.
ALTER TABLE "KnowledgeChunk"
  ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED;

CREATE INDEX "KnowledgeChunk_tsv_idx" ON "KnowledgeChunk" USING GIN ("tsv");
